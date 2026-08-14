/*
 * Draft/published lifecycle tests (memory backend)
 *
 * The memory backend mirrors the Firestore backend's slot + pointer semantics
 * exactly (same interface, same ordering rules), so all lifecycle guarantees
 * this file asserts hold for both. Firestore requires network + credentials, so
 * live coverage lives in the manual `parity-check --live` sweep documented in
 * the README.
 *
 * Guarantees under test:
 *   1. seed → default reads see published.
 *   2. createDraft snapshots published byte-for-byte (ids too).
 *   3. createDraft is idempotent (calling twice is a no-op).
 *   4. publishDraft atomically promotes draft → published; concurrent readers
 *      never observe a partial state.
 *   5. discardDraft leaves published untouched.
 *   6. Ids survive create + publish verbatim.
 *   7. publishDraft errors if no draft exists.
 *   8. Bundle mode is untouched by the lifecycle (no store calls involved).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../config.js";
import { listAvailableContexts, subjectDir, newSessionState, runInSession } from "../context/index.js";
import { resolveAdapter } from "../adapters/index.js";
import { serializeModel } from "../curriculum/index.js";
import { __setKgStoreForTest, createMemoryKgStore, kgNamespace } from "./index.js";
import { __setStorageForTest } from "../storage/index.js";
import { activateContext } from "../activate.js";
import type { HistoryFile, StorageAdapter } from "../types.js";
import type { KgNodeStore, StoredMeta } from "./types.js";

// Same storage stub the parity harness uses — history + bucket are orthogonal
// to the KG lifecycle, so we neutralise them.
const emptyHistory: HistoryFile = { version: 2, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [],
  getObjectMd5: async () => null,
  downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory,
  writeHistory: async () => {},
};

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();

// Seed both installed contexts before each test so lifecycle mutations don't
// leak across tests. Recreating the store from scratch is the simplest reset.
async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(workspace, grade, subject));
    const meta: StoredMeta = {
      contentHash: "test", seededAt: "1970-01-01T00:00:00Z",
      adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length,
    };
    await s.writeSlot(kgNamespace(workspace, grade, subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(workspace, grade, subject), "a");
  }
  return s;
}

beforeAll(() => {
  __setStorageForTest(fakeStorage);
});

beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  process.env.KG_SOURCE = "firestore"; // exercise the lifecycle-aware backend
});

afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE;
  else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

// Collect a snapshot of what published reads produce for a namespace — this is
// the oracle every round-trip test compares against.
async function readPublished(workspace: string, grade: string, subject: string) {
  const state = newSessionState();
  return runInSession(state, async () => {
    const r = await activateContext(workspace, grade, subject);
    if (!r.ok) throw new Error(`activate ${grade}/${subject}: ${r.error}`);
    const adapter = resolveAdapter(grade, subject)!;
    const m = adapter.model();
    return {
      nodes: [...m.byId.keys()].sort(),
      edges: (m.rawGraph?.relationships ?? []).map((e) => `${e.type}|${e.start}|${e.end}`).sort(),
    };
  });
}

// Raw slot dump — used to prove byte-level id preservation between slots and
// that the draft snapshot equals published bit-for-bit.
async function rawSlot(store: KgNodeStore, ns: string, slot: "a" | "b") {
  const [nodes, edges] = await Promise.all([store.listNodes(ns, slot), store.listEdges(ns, slot)]);
  // Sort by id so two dumps compare deterministically regardless of insertion
  // order (Firestore's query order isn't guaranteed either, so the harness
  // must be order-agnostic).
  const stripSlot = <T extends { slot: string }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
  return {
    nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)).map(stripSlot),
    edges: [...edges].sort((a, b) => a.id.localeCompare(b.id)).map(stripSlot),
  };
}

describe("draft/published lifecycle (memory backend)", () => {
  for (const ctx of contexts) {
    const label = `${ctx.grade}/${ctx.subject}`;
    const ns = kgNamespace(ctx.workspace, ctx.grade, ctx.subject);

    it(`${label}: default reads resolve to published`, async () => {
      const pointer = await store.readPointer(ns);
      expect(pointer).toEqual({ publishedSlot: "a", draftSlot: null });
      const snap = await readPublished(ctx.workspace, ctx.grade, ctx.subject);
      expect(snap.nodes.length).toBeGreaterThan(0);
    });

    it(`${label}: createDraft snapshots published byte-for-byte`, async () => {
      await store.createDraft(ns);
      const published = await rawSlot(store, ns, "a");
      const draft = await rawSlot(store, ns, "b");
      // Nodes and edges must be byte-identical modulo the slot field, which
      // rawSlot strips before comparison.
      expect(draft).toEqual(published);
      // Every single id survives verbatim in both directions.
      expect(new Set(draft.nodes.map((n) => n.id))).toEqual(new Set(published.nodes.map((n) => n.id)));
      expect(new Set(draft.edges.map((e) => e.id))).toEqual(new Set(published.edges.map((e) => e.id)));
      // Pointer now advertises the draft slot.
      expect(await store.readPointer(ns)).toEqual({ publishedSlot: "a", draftSlot: "b" });
    });

    it(`${label}: createDraft is idempotent`, async () => {
      await store.createDraft(ns);
      const p1 = await store.readPointer(ns);
      const draft1 = await rawSlot(store, ns, "b");
      await store.createDraft(ns); // no-op
      const p2 = await store.readPointer(ns);
      const draft2 = await rawSlot(store, ns, "b");
      expect(p2).toEqual(p1);
      expect(draft2).toEqual(draft1);
    });

    it(`${label}: create → publish → default reads unchanged`, async () => {
      const before = await readPublished(ctx.workspace, ctx.grade, ctx.subject);
      await store.createDraft(ns);
      await store.publishDraft(ns);
      // Pointer flipped, but with an unedited draft, generation must see the
      // same graph — this is the acceptance criterion for the whole step.
      expect(await store.readPointer(ns)).toEqual({ publishedSlot: "b", draftSlot: null });
      const after = await readPublished(ctx.workspace, ctx.grade, ctx.subject);
      expect(after).toEqual(before);
    });

    it(`${label}: create → discard → published untouched`, async () => {
      const before = await readPublished(ctx.workspace, ctx.grade, ctx.subject);
      await store.createDraft(ns);
      await store.discardDraft(ns);
      expect(await store.readPointer(ns)).toEqual({ publishedSlot: "a", draftSlot: null });
      const after = await readPublished(ctx.workspace, ctx.grade, ctx.subject);
      expect(after).toEqual(before);
    });

    it(`${label}: publishDraft errors when no draft exists`, async () => {
      await expect(store.publishDraft(ns)).rejects.toThrow(/no draft/i);
    });

    it(`${label}: discardDraft is a no-op when no draft exists`, async () => {
      const before = await store.readPointer(ns);
      await store.discardDraft(ns);
      expect(await store.readPointer(ns)).toEqual(before);
    });
  }

  // Atomicity is Firestore-backed in production — for the memory backend we
  // assert the equivalent property: publishing flips the pointer in a single
  // operation, so any reader that observes the pointer sees either the
  // pre-publish snapshot or the post-publish snapshot, never a mix. Racing
  // reads against a publish demonstrates this — every observation is
  // internally consistent.
  it("publish is observed atomically by concurrent readers", async () => {
    const ctx = contexts[0];
    const ns = kgNamespace(ctx.workspace, ctx.grade, ctx.subject);
    await store.createDraft(ns);
    // Kick off many pointer reads interleaved with the publish. Each
    // observation is one of the two valid states; the harness fails if any
    // read comes back with a state that isn't fully old or fully new.
    const observations: Array<{ publishedSlot: string; draftSlot: string | null } | null> = [];
    const readers = Array.from({ length: 200 }, () =>
      store.readPointer(ns).then((p) => { observations.push(p); }),
    );
    await store.publishDraft(ns);
    await Promise.all(readers);
    for (const p of observations) {
      const preFlip = p?.publishedSlot === "a" && p?.draftSlot === "b";
      const postFlip = p?.publishedSlot === "b" && p?.draftSlot === null;
      expect(preFlip || postFlip).toBe(true);
    }
  });
});

describe("bundle mode is untouched by the lifecycle", () => {
  it("activate.ts never calls the store when KG_SOURCE=bundle", async () => {
    // Tripwire store: any call throws, so the assertion below fails loudly if
    // activate.ts ever accidentally reaches for the store in bundle mode.
    const tripwire: KgNodeStore = {
      kind: "memory",
      listNodes: async () => { throw new Error("bundle mode must not touch listNodes"); },
      listEdges: async () => { throw new Error("bundle mode must not touch listEdges"); },
      readMeta: async () => { throw new Error("bundle mode must not touch readMeta"); },
      readPointer: async () => { throw new Error("bundle mode must not touch readPointer"); },
      writeSlot: async () => { throw new Error("bundle mode must not touch writeSlot"); },
      ensurePointer: async () => { throw new Error("bundle mode must not touch ensurePointer"); },
      createDraft: async () => { throw new Error("bundle mode must not touch createDraft"); },
      publishDraft: async () => { throw new Error("bundle mode must not touch publishDraft"); },
      discardDraft: async () => { throw new Error("bundle mode must not touch discardDraft"); },
      appendAudit: async () => { throw new Error("bundle mode must not touch appendAudit"); },
      listAudit: async () => { throw new Error("bundle mode must not touch listAudit"); },
    };
    __setKgStoreForTest(tripwire);
    process.env.KG_SOURCE = "bundle";
    const state = newSessionState();
    await runInSession(state, async () => {
      const ctx = contexts[0];
      const r = await activateContext(ctx.workspace, ctx.grade, ctx.subject);
      expect(r.ok).toBe(true);
    });
  });
});
