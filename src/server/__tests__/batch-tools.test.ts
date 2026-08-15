/*
 * add_nodes / create_edges tool cores — returnMode, idempotency, two-phase integrity
 *
 * Drives the exported cores (runAddNodes / runCreateEdges) against the seeded
 * CI-maths store, exercising the tool-layer behaviour the framework tests don't:
 *   • returnMode — "summary" omits the diff and carries counts; "full" adds the diff.
 *   • idempotency — a keyed confirm replays instead of REPLAY; a reused key with a
 *     different payload is a mismatch; no key keeps strict single-use; TTL evicts.
 *   • two-phase integrity — a no-confirm call stages NOTHING (the reported
 *     "dry-run applied anyway" bug, asserted via namespace_stats.draft).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { listAvailableContexts, newSessionState, runInSession } from "../../context/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import { __setKgStoreForTest, createMemoryKgStore, kgNamespace, __resetMutationsForTest, __resetDraftTokensForTest } from "../../kg-store/index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import { activateContext } from "../../activate.js";
import { runAddNodes } from "../authoring.js";
import { runCreateEdges } from "../structural.js";
import { namespaceStats } from "../graph.js";
import { __resetIdempotencyForTest, __setIdempotencyNowForTest } from "../idempotency.js";
import type { KgNodeStore, StoredMeta } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const emptyHistory: HistoryFile = { version: 3, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [], getObjectMd5: async () => null, downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory, writeHistory: async () => {},
};
const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const ns = kgNamespace(targetCtx.grade, targetCtx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await freshStore.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await freshStore.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return freshStore;
}

async function withActiveContext<T>(fn: () => Promise<T>): Promise<T> {
  const state = newSessionState();
  return runInSession(state, async () => {
    __setActorForTest(CURATOR);
    const activation = await activateContext(targetCtx.workspace, targetCtx.grade, targetCtx.subject);
    if (!activation.ok) throw new Error(`activate: ${activation.error}`);
    return fn();
  });
}

// A stable existing parent (the first chapter) to attach batch nodes under.
async function firstChapterId(): Promise<string> {
  const nodes = await store.listNodes(ns, "a");
  const chapter = nodes.find(
    (node) => (node.labels ?? []).includes("LessonGrouping") && (node.properties?.raw as Record<string, unknown> | undefined)?.groupName === "Chapitre",
  );
  return chapter!.id;
}

// N add_nodes items creating Lessons under one parent.
const lessonItems = (parentId: string, count: number) =>
  Array.from({ length: count }, (_unused, index) => ({ kind: "Lesson", parentId, description: `Batch lesson ${index + 1}` }));

// Preview an add_nodes batch, then confirm it (echoing the minted ids). Returns
// both responses. Optional idempotencyKey is applied on the confirm.
async function addNodesPreviewThenConfirm(items: ReturnType<typeof lessonItems>, opts: { key?: string } = {}) {
  const preview = await runAddNodes({ items });
  const confirm = await runAddNodes({
    items,
    confirm: true,
    confirmationToken: preview.confirmationToken as string,
    mintedNodeIds: preview.mintedNodeIds as string[],
    idempotencyKey: opts.key,
  });
  return { preview, confirm };
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  __resetDraftTokensForTest();
  __resetIdempotencyForTest();
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE; else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

describe("returnMode", () => {
  it("summary (default) omits the diff and returns counts", async () => {
    const result = await withActiveContext(async () => runAddNodes({ items: lessonItems(await firstChapterId(), 3) }));
    expect(result.diff).toBeUndefined();
    expect(result.counts).toEqual({ nodesAdded: 3, edgesAdded: 3, nodesChanged: 0, nodesRemoved: 0, edgesRemoved: 0 });
    // Everything a caller needs to progress is still present.
    expect(typeof result.confirmationToken).toBe("string");
    expect((result.mintedNodeIds as string[]).length).toBe(3);
  });

  it("full returns the diff alongside the SAME counts", async () => {
    const result = await withActiveContext(async () => runAddNodes({ items: lessonItems(await firstChapterId(), 3), returnMode: "full" }));
    expect(result.diff).toBeDefined();
    const diff = result.diff as { nodes: { added: unknown[] }; edges: { added: unknown[] } };
    expect(diff.nodes.added.length).toBe(3);
    expect(result.counts).toEqual({ nodesAdded: 3, edgesAdded: 3, nodesChanged: 0, nodesRemoved: 0, edgesRemoved: 0 });
  });

  it("create_edges summary carries counts and no diff", async () => {
    const result = await withActiveContext(async () => {
      const nodes = await store.listNodes(ns, "a");
      const edgeType = (await store.listEdges(ns, "a"))[0].type;
      // Two fresh edges of an observed type between existing, unconnected nodes.
      const [a, b, c] = nodes.map((node) => node.id);
      return runCreateEdges({ edges: [{ edgeType, fromId: a, toId: b }, { edgeType, fromId: a, toId: c }] });
    });
    // These particular pairs may already be linked in the seed; assert the shape,
    // not the count — summary must have counts and no diff regardless.
    expect(result.diff).toBeUndefined();
    expect(result.counts).toBeDefined();
  });
});

describe("idempotency", () => {
  it("replays a keyed confirm (same key + payload) with no double-apply", async () => {
    const outcome = await withActiveContext(async () => {
      const items = lessonItems(await firstChapterId(), 2);
      const preview = await runAddNodes({ items });

      // A real retry re-sends the IDENTICAL request: same token, same minted ids,
      // same key. The first applies; the second replays the stored summary.
      const confirmArgs = {
        items, confirm: true,
        confirmationToken: preview.confirmationToken as string,
        mintedNodeIds: preview.mintedNodeIds as string[],
        idempotencyKey: "key-A",
      };
      const confirm = await runAddNodes(confirmArgs);
      const replay = await runAddNodes(confirmArgs);
      const applyRecords = await store.listAudit({ namespace: ns, eventType: "apply" });
      return { confirm, replay, applyCount: applyRecords.length };
    });

    expect(outcome.confirm.ok).toBe(true);
    expect(outcome.replay.replayed).toBe(true);
    expect(outcome.replay.ok).toBe(true);
    expect(outcome.replay.counts).toEqual(outcome.confirm.counts);
    expect(outcome.applyCount).toBe(1); // recorded once — no double audit
  });

  it("rejects a reused key with a different payload (IDEMPOTENCY_KEY_MISMATCH)", async () => {
    const outcome = await withActiveContext(async () => {
      const parentId = await firstChapterId();
      const { confirm } = await addNodesPreviewThenConfirm(lessonItems(parentId, 2), { key: "key-B" });

      // A DIFFERENT batch, same key.
      const otherItems = lessonItems(parentId, 3);
      const preview = await runAddNodes({ items: otherItems });
      const mismatch = await runAddNodes({
        items: otherItems, confirm: true,
        confirmationToken: preview.confirmationToken as string,
        mintedNodeIds: preview.mintedNodeIds as string[],
        idempotencyKey: "key-B",
      });
      const applyRecords = await store.listAudit({ namespace: ns, eventType: "apply" });
      return { confirm, mismatch, applyCount: applyRecords.length };
    });

    expect(outcome.mismatch.ok).toBe(false);
    expect(outcome.mismatch.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
    // The original applied summary is attached; the new batch was NOT applied.
    expect((outcome.mismatch.original as { counts: unknown }).counts).toEqual(outcome.confirm.counts);
    expect(outcome.applyCount).toBe(1);
  });

  it("without a key, a reused token still returns REPLAY (strict single-use)", async () => {
    const replay = await withActiveContext(async () => {
      const items = lessonItems(await firstChapterId(), 1);
      const preview = await runAddNodes({ items });
      const args = { items, confirm: true, confirmationToken: preview.confirmationToken as string, mintedNodeIds: preview.mintedNodeIds as string[] };
      await runAddNodes(args);          // first confirm applies
      return runAddNodes(args);         // second confirm — no key
    });
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe("REPLAY");
  });

  it("expires a key after its TTL (a later reuse applies fresh, not a mismatch)", async () => {
    const outcome = await withActiveContext(async () => {
      const parentId = await firstChapterId();
      await addNodesPreviewThenConfirm(lessonItems(parentId, 1), { key: "key-C" }); // recorded at t0

      // Jump the idempotency clock past the 24h TTL.
      const past = Date.now() + 25 * 60 * 60 * 1000;
      __setIdempotencyNowForTest(() => past);

      // A NEW batch reusing the key: the old entry has expired, so this is a fresh
      // apply (not a mismatch, which is what a live stale entry would produce).
      const items = lessonItems(parentId, 2);
      const preview = await runAddNodes({ items });
      const fresh = await runAddNodes({
        items, confirm: true,
        confirmationToken: preview.confirmationToken as string,
        mintedNodeIds: preview.mintedNodeIds as string[],
        idempotencyKey: "key-C",
      });
      const applyRecords = await store.listAudit({ namespace: ns, eventType: "apply" });
      return { fresh, applyCount: applyRecords.length };
    });

    expect(outcome.fresh.ok).toBe(true);
    expect(outcome.fresh.replayed).toBeUndefined();
    expect(outcome.applyCount).toBe(2); // two real applies, not a replay
  });
});

describe("two-phase integrity", () => {
  it("a no-confirm call stages NOTHING on the draft", async () => {
    const outcome = await withActiveContext(async () => {
      const before = await namespaceStats();
      const parentId = await firstChapterId();

      // Several dry-runs across both batch tools — none may open a draft.
      await runAddNodes({ items: lessonItems(parentId, 5) });
      await runAddNodes({ items: lessonItems(parentId, 5), returnMode: "full" });
      await runCreateEdges({ edges: [{ edgeType: (await store.listEdges(ns, "a"))[0].type, fromId: parentId, toId: parentId }] });

      const after = await namespaceStats();
      return { before: before.draft, after: after.draft };
    });
    expect(outcome.before).toEqual({ open: false });
    expect(outcome.after).toEqual({ open: false }); // dry-runs staged nothing
  });
});
