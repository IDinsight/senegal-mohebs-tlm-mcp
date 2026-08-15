/*
 * publish_draft / discard_draft tool cores — returnMode shaping
 *
 * Drives the exported cores (runPublishDraft / runDiscardDraft) against the
 * seeded CI-maths store, asserting the tool-layer response shape the kg-store
 * tests (curator-loop) don't cover:
 *   • summary (the default) drops the whole-draft diff for a compact `counts`
 *     object; "full" keeps the diff (and the staged profileDiff).
 *   • warnings ride VERBATIM in both modes on publish — an approver must see
 *     coverage flags before promoting.
 *   • the commit results (already diff-free) keep their audit fields.
 *   • an empty draft still returns the "nothing to do" notice.
 *
 * A curator stages one edit; an approver publishes — matching the real roles.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { CONFIG } from "../../config.js";
import { listAvailableContexts, subjectDir, newSessionState, runInSession } from "../../context/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, __resetMutationsForTest, __resetDraftTokensForTest,
} from "../../kg-store/index.js";
import { reposition } from "../../kg-recipes/index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import { activateContext } from "../../activate.js";
import { runPublishDraft, runDiscardDraft } from "../lifecycle.js";
import type { KgNodeStore, StoredMeta } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const emptyHistory: HistoryFile = { version: 2, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [], getObjectMd5: async () => null, downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory, writeHistory: async () => {},
};
const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };
const APPROVER: Actor = { id: "approver-uid", email: "approver@test", role: "approver", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const ns = kgNamespace(targetCtx.grade, targetCtx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await freshStore.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await freshStore.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return freshStore;
}

// Run `fn` inside an active ci/maths session as `actor` — the cores read the
// active namespace from the session bag, so every core call needs one.
async function withActiveContextAs<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
  const state = newSessionState();
  return runInSession(state, async () => {
    __setActorForTest(actor);
    const activation = await activateContext(targetCtx.workspace, targetCtx.grade, targetCtx.subject);
    if (!activation.ok) throw new Error(`activate: ${activation.error}`);
    return fn();
  });
}

// Stage exactly one edit (reposition the first chapter) onto the draft as the
// curator — the minimal draft the publish/discard cores act on.
async function stageOneEditAsCurator(): Promise<void> {
  await withActiveContextAs(CURATOR, async () => {
    const nodes = await store.listNodes(ns, "a");
    const chapterId = nodes.find((n) => n.type === "Chapitre")!.id;
    const args = { namespace: ns, nodeId: chapterId, position: 9 };
    const preview = await runGraphMutation({ namespace: ns, mutation: reposition, args });
    if (preview.phase !== "preview") throw new Error("expected a preview");
    await runGraphMutation({ namespace: ns, mutation: reposition, args, confirm: true, token: preview.confirmationToken });
  });
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  __resetDraftTokensForTest();
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE; else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

describe("publish_draft returnMode", () => {
  it("summary (default) dry-run: confirmationToken + counts + warnings, no diff", async () => {
    await stageOneEditAsCurator();
    const dryRun = await withActiveContextAs(APPROVER, () => runPublishDraft({}));
    expect(dryRun.phase).toBe("preview");
    expect(typeof dryRun.confirmationToken).toBe("string");
    // One node repositioned → exactly one nodesChanged, nothing else.
    expect(dryRun.counts).toEqual({ nodesAdded: 0, edgesAdded: 0, nodesChanged: 1, nodesRemoved: 0, edgesRemoved: 0 });
    expect(Array.isArray(dryRun.warnings)).toBe(true);
    // The big payloads are dropped in summary.
    expect(dryRun.diff).toBeUndefined();
    expect(dryRun.profileDiff).toBeUndefined();
  });

  it("full dry-run: the whole-draft diff (and profileDiff) alongside the same counts", async () => {
    await stageOneEditAsCurator();
    const dryRun = await withActiveContextAs(APPROVER, () => runPublishDraft({ returnMode: "full" }));
    expect(dryRun.diff).toBeDefined();
    const diff = dryRun.diff as { nodes: { changed: unknown[] } };
    expect(diff.nodes.changed.length).toBe(1);
    // A draft always carries a profileDiff (changed:false when unedited) — full mode keeps it.
    expect(dryRun.profileDiff).toBeDefined();
    expect(dryRun.counts).toEqual({ nodesAdded: 0, edgesAdded: 0, nodesChanged: 1, nodesRemoved: 0, edgesRemoved: 0 });
  });

  it("warnings are identical (verbatim) in summary and full modes", async () => {
    await stageOneEditAsCurator();
    const { summary, full } = await withActiveContextAs(APPROVER, async () => ({
      summary: await runPublishDraft({}),
      full: await runPublishDraft({ returnMode: "full" }),
    }));
    expect(summary.warnings).toEqual(full.warnings);
  });

  it("commit (summary): auditId + publishedSlot + warningsAtPublish, no diff", async () => {
    await stageOneEditAsCurator();
    const commit = await withActiveContextAs(APPROVER, async () => {
      const dryRun = await runPublishDraft({});
      return runPublishDraft({ confirm: true, confirmationToken: dryRun.confirmationToken as string });
    });
    expect(commit.phase).toBe("commit");
    expect(commit.ok).toBe(true);
    expect(typeof commit.auditId).toBe("string");
    expect(commit.publishedSlot).toBe("b");           // draft slot promoted
    expect(Array.isArray(commit.warningsAtPublish)).toBe(true);
    expect(commit.diff).toBeUndefined();
  });
});

describe("discard_draft returnMode", () => {
  it("summary dry-run: confirmationToken + counts, no diff; commit: auditId + discardedApplyIds, no diff", async () => {
    await stageOneEditAsCurator();
    const { dryRun, commit } = await withActiveContextAs(CURATOR, async () => {
      const dryRun = await runDiscardDraft({});
      const commit = await runDiscardDraft({ confirm: true, confirmationToken: dryRun.confirmationToken as string });
      return { dryRun, commit };
    });
    // Dry-run summary.
    expect(dryRun.phase).toBe("preview");
    expect(typeof dryRun.confirmationToken).toBe("string");
    expect(dryRun.counts).toEqual({ nodesAdded: 0, edgesAdded: 0, nodesChanged: 1, nodesRemoved: 0, edgesRemoved: 0 });
    expect(dryRun.diff).toBeUndefined();
    // Commit summary.
    expect(commit.phase).toBe("commit");
    expect(commit.ok).toBe(true);
    expect(typeof commit.auditId).toBe("string");
    expect((commit.discardedApplyIds as string[]).length).toBe(1);
    expect(commit.diff).toBeUndefined();
    // The draft is gone.
    expect((await store.readPointer(ns))?.draftSlot).toBe(null);
  });

  it("full dry-run keeps the diff", async () => {
    await stageOneEditAsCurator();
    const dryRun = await withActiveContextAs(CURATOR, () => runDiscardDraft({ returnMode: "full" }));
    expect(dryRun.diff).toBeDefined();
    expect(dryRun.counts).toBeDefined();
  });
});

describe("empty draft: nothing-to-do in summary mode", () => {
  it("publish_draft with no draft returns hasDraft:false, no token, no counts", async () => {
    const result = await withActiveContextAs(APPROVER, () => runPublishDraft({}));
    expect(result.phase).toBe("preview");
    expect(result.hasDraft).toBe(false);
    expect(result.confirmationToken).toBeUndefined();
    expect(result.counts).toBeUndefined();
    expect(result.diff).toBeUndefined();
  });

  it("discard_draft with no draft returns hasDraft:false, no token, no counts", async () => {
    const result = await withActiveContextAs(CURATOR, () => runDiscardDraft({}));
    expect(result.phase).toBe("preview");
    expect(result.hasDraft).toBe(false);
    expect(result.confirmationToken).toBeUndefined();
    expect(result.counts).toBeUndefined();
    expect(result.diff).toBeUndefined();
  });
});
