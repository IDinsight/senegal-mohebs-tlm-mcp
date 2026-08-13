/*
 * read_audit — the approver-gated audit reader (#16)
 *
 * Proves the whole contract: approver-only gating (curator / no-role blocked,
 * and the blocked read itself audited), namespace scoping, the filter set
 * (actor / action / outcome / nodeId / time), newest-first cursor pagination,
 * summary-vs-detail payloads, the STRICT read-only invariant (the append-only
 * log is byte-for-byte unaffected by reads, aside from the lightweight
 * read-events it appends), the read-event being lightweight + non-recursive,
 * and the end-to-end readback verification of a known session (applies /
 * createDraft / publish-with-self-authorship / discard / force-cascade delete /
 * recipe / blocked all present and correctly attributed).
 *
 * Setup mirrors capabilities.test.ts / audit.test.ts: a memory KG store seeded
 * from the real sources, KG_SOURCE=firestore to exercise the lifecycle path,
 * and the tool's exported core (`readAudit`) driven directly inside an active
 * context + actor.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../config.js";
import { listAvailableContexts, subjectDir, newSessionState, runInSession } from "../context/index.js";
import { resolveAdapter } from "../adapters/index.js";
import { serializeModel } from "../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace, toAuditActor,
  runGraphMutation, upsertProperty, deleteNode, publishDraftWithConfirm, discardDraftWithConfirm,
  __resetMutationsForTest,
} from "../kg-store/index.js";
import type { KgNodeStore, StoredMeta, AuditRecord, GraphMutation, GraphDiff } from "../kg-store/index.js";
import { __setStorageForTest } from "../storage/index.js";
import { __setActorForTest, runAsActor, type Actor } from "../actor.js";
import { activateContext } from "../activate.js";
import { readAudit } from "./audit.js";
import type { StorageAdapter, HistoryFile } from "../types.js";

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

const APPROVER: Actor = { id: "approver-uid", email: "approver@test", tokenIssuer: "iss", role: "approver", unknown: false };
const CURATOR: Actor = { id: "curator-uid", email: "curator@test", tokenIssuer: "iss", role: "curator", unknown: false };
const NO_ROLE: Actor = { id: "guest-uid", email: "guest@test", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const otherCtx = contexts.find((c) => !(c.grade === "ci" && c.subject === "maths"));
const ns = kgNamespace(targetCtx.grade, targetCtx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = {
      contentHash: "test", seededAt: "1970-01-01T00:00:00Z",
      adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length,
    };
    await s.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return s;
}

// Run inside an active context as a given actor — exactly what a real tool
// invocation runs (minus the JSON envelope), the same pattern as
// capabilities.test.ts::withActiveContext.
async function withCtx<T>(workspace: string, grade: string, subject: string, actor: Actor | null, fn: () => Promise<T>): Promise<T> {
  const state = newSessionState();
  return runInSession(state, async () => {
    __setActorForTest(actor);
    const r = await activateContext(workspace, grade, subject);
    if (!r.ok) throw new Error(`activate ${workspace}/${grade}/${subject}: ${r.error}`);
    return fn();
  });
}
const inTarget = <T>(actor: Actor | null, fn: () => Promise<T>) => withCtx(targetCtx.workspace, targetCtx.grade, targetCtx.subject, actor, fn);

// Build a plausible audit record for the seeding-based filter/pagination tests.
function rec(partial: Partial<AuditRecord> & Pick<AuditRecord, "id" | "ts" | "eventType">): AuditRecord {
  return {
    actor: toAuditActor(APPROVER),
    namespace: ns,
    ...partial,
  } as AuditRecord;
}
const emptyDiff = (): GraphDiff => ({ nodes: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [], changed: [] } });

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE;
  else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

// ── Role gating (f) ──────────────────────────────────────────────────────────

describe("role gating: approver-only, blocked reads are themselves audited", () => {
  it("an approver is allowed and gets a page", async () => {
    const out = await inTarget(APPROVER, () => readAudit({}));
    expect(out.phase).toBeUndefined();       // not unauthorized
    expect(out.namespace).toBe(ns);
    expect(Array.isArray(out.records)).toBe(true);
  });

  for (const [label, actor] of [["curator", CURATOR], ["no-role", NO_ROLE], ["unknown", null]] as const) {
    it(`a ${label} caller is BLOCKED and the denial is audited (no records leaked)`, async () => {
      const out = await inTarget(actor, () => readAudit({}));
      expect(out.phase).toBe("unauthorized");
      expect(out.action).toBe("readAudit");
      expect(out.records).toBeUndefined();     // no audit content reaches a denied caller
      // The blocked read is recorded as a `blocked` event (not a `read`),
      // attributed to the caller.
      const blocked = (await store.listAudit({ namespace: ns, eventType: "blocked" }));
      expect(blocked).toHaveLength(1);
      expect(blocked[0].reason).toMatch(/^unauthorized:/);
      expect(blocked[0].actor.id).toBe(actor?.id ?? "unknown");
      // A denied read appends NO `read` event — only the blocked one.
      expect(await store.listAudit({ namespace: ns, eventType: "read" })).toHaveLength(0);
    });
  }
});

// ── Namespace scoping (e) ────────────────────────────────────────────────────

describe("namespace scoping: strict — current context only, no namespace argument", () => {
  it("an approver sees only the active namespace; switching context changes scope", async () => {
    // Seed one record under the target ns and one under another real ns.
    await store.appendAudit(rec({ id: "in-target", ts: "2026-07-20T00:00:00Z", eventType: "apply", mutation: "m", diff: emptyDiff(), namespace: ns }));
    if (otherCtx) {
      const otherNs = kgNamespace(otherCtx.grade, otherCtx.subject);
      await store.appendAudit(rec({ id: "in-other", ts: "2026-07-20T00:00:00Z", eventType: "apply", mutation: "m", diff: emptyDiff(), namespace: otherNs }));
    }

    const here = await inTarget(APPROVER, () => readAudit({ action: "apply", mode: "detail" }));
    const ids = (here.records as AuditRecord[]).map((r) => r.id);
    expect(ids).toContain("in-target");
    expect(ids).not.toContain("in-other");

    if (otherCtx) {
      const there = await withCtx(otherCtx.workspace, otherCtx.grade, otherCtx.subject, APPROVER, () => readAudit({ action: "apply", mode: "detail" }));
      const otherIds = (there.records as AuditRecord[]).map((r) => r.id);
      expect(otherIds).toContain("in-other");
      expect(otherIds).not.toContain("in-target");
      expect(there.namespace).toBe(kgNamespace(otherCtx.grade, otherCtx.subject));
    }
  });
});

// ── Filters (a) ──────────────────────────────────────────────────────────────

describe("filters: actor, action, outcome, nodeId, time range", () => {
  beforeEach(async () => {
    // A small, deterministic, fixed-timestamp corpus under the target ns.
    const alice = toAuditActor({ id: "alice", role: "curator", unknown: false });
    const bob = toAuditActor({ id: "bob", role: "approver", unknown: false });
    const touching: GraphDiff = {
      nodes: { added: [], removed: [], changed: [{ id: "node-X", before: {}, after: {} }] },
      edges: { added: [], removed: [], changed: [] },
    };
    const edgeTouching: GraphDiff = {
      nodes: { added: [], removed: [], changed: [] },
      edges: { added: [{ id: "hasChild:node-X->node-Y", after: { from: "node-X", to: "node-Y" } }], removed: [], changed: [] },
    };
    const records: AuditRecord[] = [
      { id: "a1", ts: "2026-07-10T10:00:00Z", actor: alice, namespace: ns, eventType: "apply", mutation: "upsertProperty", diff: touching, baseVersion: "v0", resultingVersion: "v1" },
      { id: "a2", ts: "2026-07-11T10:00:00Z", actor: bob, namespace: ns, eventType: "apply", mutation: "deleteNode", diff: edgeTouching, baseVersion: "v1", resultingVersion: "v2" },
      { id: "b1", ts: "2026-07-12T10:00:00Z", actor: alice, namespace: ns, eventType: "blocked", mutation: "rename", reason: "Rule 1: id immutable" },
      { id: "p1", ts: "2026-07-13T10:00:00Z", actor: bob, namespace: ns, eventType: "publish", promotedApplyIds: ["a1"], selfAuthored: false },
      { id: "x1", ts: "2026-07-14T10:00:00Z", actor: bob, namespace: ns, eventType: "apply", mutation: "createNode", diff: emptyDiff(), baseVersion: "v2", resultingVersion: "v3" },
    ];
    for (const r of records) await store.appendAudit(r);
  });

  const idsOf = (out: Record<string, unknown>) => (out.records as AuditRecord[]).map((r) => r.id);

  it("actor filter narrows to that actorId", async () => {
    const out = await inTarget(APPROVER, () => readAudit({ actor: "alice", mode: "detail" }));
    expect(idsOf(out).sort()).toEqual(["a1", "b1"]);
  });

  it("action filter narrows to that event type", async () => {
    const out = await inTarget(APPROVER, () => readAudit({ action: "apply", mode: "detail" }));
    expect(idsOf(out).sort()).toEqual(["a1", "a2", "x1"]);
  });

  it("outcome=blocked returns only blocked; outcome=applied excludes blocked", async () => {
    const blocked = await inTarget(APPROVER, () => readAudit({ outcome: "blocked", mode: "detail" }));
    expect(idsOf(blocked)).toEqual(["b1"]);
    const applied = await inTarget(APPROVER, () => readAudit({ outcome: "applied", mode: "detail" }));
    // Every returned record is a non-blocked (applied) event, and all four
    // seeded applied records are present. (A prior read may have appended a
    // `read` event, which is itself an applied event — so we assert the
    // relationship, not an exact set.)
    expect((applied.records as AuditRecord[]).every((r) => r.eventType !== "blocked")).toBe(true);
    expect(idsOf(applied)).toEqual(expect.arrayContaining(["a1", "a2", "p1", "x1"]));
    expect(idsOf(applied)).not.toContain("b1");
  });

  it("nodeId matches apply records whose diff touches the node (node OR incident edge); excludes non-apply", async () => {
    const out = await inTarget(APPROVER, () => readAudit({ nodeId: "node-X", mode: "detail" }));
    // a1 changes node-X directly; a2 has an edge node-X->node-Y. Nothing else.
    expect(idsOf(out).sort()).toEqual(["a1", "a2"]);
  });

  it("time range (since/until, inclusive) bounds the window", async () => {
    const out = await inTarget(APPROVER, () => readAudit({ since: "2026-07-11T10:00:00Z", until: "2026-07-13T10:00:00Z", mode: "detail" }));
    expect(idsOf(out).sort()).toEqual(["a2", "b1", "p1"]);
  });

  it("filters compose (AND): actor=bob AND action=apply", async () => {
    const out = await inTarget(APPROVER, () => readAudit({ actor: "bob", action: "apply", mode: "detail" }));
    expect(idsOf(out).sort()).toEqual(["a2", "x1"]);
  });

  it("an unknown action value is rejected with a helpful error", async () => {
    const out = await inTarget(APPROVER, () => readAudit({ action: "nope" }));
    expect(out.error).toMatch(/Unknown action/);
  });
});

// ── Pagination + ordering (b) ────────────────────────────────────────────────

describe("pagination: newest-first, stable opaque cursor, page-size cap", () => {
  beforeEach(async () => {
    // Five apply records with strictly increasing timestamps. Filtering the
    // reads by action:"apply" keeps the tool's own `read` events out of the
    // paged set (they are eventType:"read").
    for (const i of [1, 2, 3, 4, 5]) {
      await store.appendAudit(rec({ id: `p${i}`, ts: `2026-07-0${i}T10:00:00Z`, eventType: "apply", mutation: "m", diff: emptyDiff(), baseVersion: "v", resultingVersion: "v" }));
    }
  });

  it("returns newest-first and walks the whole log via nextCursor with no overlap", async () => {
    const page1 = await inTarget(APPROVER, () => readAudit({ action: "apply", limit: 2, mode: "detail" }));
    expect((page1.records as AuditRecord[]).map((r) => r.id)).toEqual(["p5", "p4"]);
    expect(typeof page1.nextCursor).toBe("string");

    const page2 = await inTarget(APPROVER, () => readAudit({ action: "apply", limit: 2, mode: "detail", cursor: page1.nextCursor as string }));
    expect((page2.records as AuditRecord[]).map((r) => r.id)).toEqual(["p3", "p2"]);
    expect(typeof page2.nextCursor).toBe("string");

    const page3 = await inTarget(APPROVER, () => readAudit({ action: "apply", limit: 2, mode: "detail", cursor: page2.nextCursor as string }));
    expect((page3.records as AuditRecord[]).map((r) => r.id)).toEqual(["p1"]);
    // Last page → no nextCursor.
    expect(page3.nextCursor).toBeUndefined();
  });

  it("limit is capped and floored; a malformed cursor is rejected cleanly", async () => {
    const capped = await inTarget(APPROVER, () => readAudit({ action: "apply", limit: 9999, mode: "detail" }));
    expect((capped.records as AuditRecord[]).length).toBe(5);   // all five, under the 100 cap
    const bad = await inTarget(APPROVER, () => readAudit({ action: "apply", cursor: "!!!not-base64!!!" }));
    expect(bad.error).toMatch(/Invalid cursor/);
  });
});

// ── Summary vs detail (c) ────────────────────────────────────────────────────

describe("summary (default) vs detail payloads", () => {
  beforeEach(async () => {
    await store.appendAudit(rec({
      id: "ap", ts: "2026-07-10T10:00:00Z", eventType: "apply", mutation: "upsertProperty",
      baseVersion: "v0", resultingVersion: "v1",
      diff: { nodes: { added: [], removed: [], changed: [{ id: "n1", before: { title: "old" }, after: { title: "new" } }] }, edges: { added: [], removed: [], changed: [] } },
    }));
    await store.appendAudit(rec({ id: "pub", ts: "2026-07-11T10:00:00Z", eventType: "publish", promotedApplyIds: ["ap"], selfAuthored: true }));
  });

  it("summary mode is compact — no before/after; carries a target descriptor + self-authorship on publish", async () => {
    const out = await inTarget(APPROVER, () => readAudit({ action: "apply" }));   // default mode = summary
    expect(out.mode).toBe("summary");
    const r = (out.records as Record<string, unknown>[])[0];
    expect(r.auditId).toBe("ap");
    expect(r.action).toBe("apply");
    expect(r.outcome).toBe("applied");
    expect(typeof r.target).toBe("string");
    // Compact: NO diff / before / after on a summary row.
    expect(r).not.toHaveProperty("diff");
    expect(r).not.toHaveProperty("before");
    expect(r).not.toHaveProperty("after");

    const pub = await inTarget(APPROVER, () => readAudit({ action: "publish" }));
    expect((pub.records as Record<string, unknown>[])[0].selfAuthored).toBe(true);
  });

  it("detail mode returns the full record including the before/after diff", async () => {
    const out = await inTarget(APPROVER, () => readAudit({ action: "apply", mode: "detail" }));
    const r = (out.records as AuditRecord[])[0];
    expect(r.diff?.nodes.changed[0]).toEqual({ id: "n1", before: { title: "old" }, after: { title: "new" } });
  });

  it("auditId fetches exactly that record in detail; a missing id reports notFound", async () => {
    const one = await inTarget(APPROVER, () => readAudit({ auditId: "ap" }));
    expect(one.mode).toBe("detail");
    expect(one.count).toBe(1);
    expect((one.records as AuditRecord[])[0].id).toBe("ap");
    expect((one.records as AuditRecord[])[0].diff).toBeDefined();

    const none = await inTarget(APPROVER, () => readAudit({ auditId: "does-not-exist" }));
    expect(none.count).toBe(0);
    expect(none.notFound).toMatch(/does-not-exist/);
  });
});

// ── The read-event (d): lightweight, non-recursive, visible + filterable ─────

describe("read-event: lightweight, non-recursive, visible + filterable", () => {
  it("each successful read appends exactly ONE read event — actor + query + count, never a before/after", async () => {
    await inTarget(APPROVER, () => readAudit({ actor: "someone", limit: 7 }));
    const reads = await store.listAudit({ namespace: ns, eventType: "read" });
    expect(reads).toHaveLength(1);
    const ev = reads[0];
    expect(ev.actor.id).toBe(APPROVER.id);
    expect(typeof ev.readQuery).toBe("string");
    expect(ev.readQuery).toContain("someone");
    expect(typeof ev.readCount).toBe("number");
    // Lightweight: a read event NEVER carries graph state.
    expect(ev.diff).toBeUndefined();
    expect(ev).not.toHaveProperty("before");
    expect(ev).not.toHaveProperty("after");
    expect(ev.promotedApplyIds).toBeUndefined();
  });

  it("reads grow the log LINEARLY (one read event each), never recursively", async () => {
    for (let i = 0; i < 4; i++) await inTarget(APPROVER, () => readAudit({}));
    // Four reads → exactly four read events. No feedback loop, no bloat.
    expect((await store.listAudit({ namespace: ns, eventType: "read" }))).toHaveLength(4);
  });

  it("read events are first-class and filterable — action:read surfaces them; action:apply excludes them", async () => {
    await inTarget(APPROVER, () => readAudit({}));                 // appends read #1
    const asReads = await inTarget(APPROVER, () => readAudit({ action: "read", mode: "detail" }));
    // The first read event is visible to the second read (appended before it ran).
    expect((asReads.records as AuditRecord[]).every((r) => r.eventType === "read")).toBe(true);
    expect((asReads.records as AuditRecord[]).length).toBeGreaterThanOrEqual(1);
    const asApplies = await inTarget(APPROVER, () => readAudit({ action: "apply", mode: "detail" }));
    expect((asApplies.records as AuditRecord[]).some((r) => r.eventType === "read")).toBe(false);
  });
});

// ── Read-only invariant: the append-only log is byte-for-byte unaffected ──────

describe("STRICT read-only: reads never alter existing records (append-only preserved)", () => {
  it("any number of reads leave prior records byte-identical; the ONLY additions are read events", async () => {
    const seeded: AuditRecord[] = [
      rec({ id: "s1", ts: "2026-07-01T10:00:00Z", eventType: "apply", mutation: "m", diff: emptyDiff(), baseVersion: "v0", resultingVersion: "v1" }),
      rec({ id: "s2", ts: "2026-07-02T10:00:00Z", eventType: "publish", promotedApplyIds: ["s1"], selfAuthored: false }),
      rec({ id: "s3", ts: "2026-07-03T10:00:00Z", eventType: "blocked", mutation: "rename", reason: "Rule 1" }),
    ];
    for (const r of seeded) await store.appendAudit(r);
    const before = await store.listAudit({ namespace: ns });

    // Hammer the reader with a variety of queries.
    const NUM_READS = 6;
    await inTarget(APPROVER, async () => {
      await readAudit({});
      await readAudit({ action: "apply", mode: "detail" });
      await readAudit({ outcome: "blocked" });
      await readAudit({ nodeId: "whatever" });
      await readAudit({ auditId: "s1" });
      await readAudit({ limit: 1 });
    });

    const after = await store.listAudit({ namespace: ns });
    // Every original record survives byte-for-byte.
    for (const orig of before) {
      const found = after.find((r) => r.id === orig.id);
      expect(found).toEqual(orig);
    }
    // The only new records are read events, and there is exactly one per read.
    const added = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(added.every((r) => r.eventType === "read")).toBe(true);
    expect(added).toHaveLength(NUM_READS);
    // No record was removed.
    expect(after.length).toBe(before.length + NUM_READS);
  });
});

// ── Readback verification of a known session (closes the manual check) ───────
// Drive a realistic session through the REAL mutation framework as an approver
// (+ a curator sub-step for the denial), then read it back through the tool and
// assert every event kind is present and correctly attributed. Recipe WRITING
// is #14's tested concern; here we seed one recipe apply record so the reader's
// faithful surfacing of recipe events is asserted too.

describe("readback verification: a known session is present, well-formed, and attributed", () => {
  it("applies, createDraft, publish(self-authored), discard, force-cascade delete, recipe, and blocks all read back", async () => {
    await inTarget(APPROVER, async () => {
      const adapter = resolveAdapter(targetCtx.grade, targetCtx.subject)!;
      const nodes = await store.listNodes(ns, "a");
      const editTarget = nodes.find((n) => n.type === "chapter" && typeof (n.properties as { title?: unknown }).title === "string")!;
      const chapterToDelete = nodes.find((n) => n.type === "chapter" && n.id !== editTarget.id)!;

      // 1. apply (upsert) → lazily creates the draft (createDraft + apply).
      const upArgs = { nodeId: editTarget.id, key: "title", value: "Known-session edit", aliases: adapter.wordingAliases };
      const p1 = await runGraphMutation({ namespace: ns, mutation: upsertProperty, args: upArgs });
      if (p1.phase !== "preview") throw new Error(`upsert preview expected, got ${p1.phase}`);
      await runGraphMutation({ namespace: ns, mutation: upsertProperty, args: upArgs, confirm: true, token: p1.confirmationToken });

      // 2. publish (approver authored the apply → selfAuthored true).
      const pubPrev = await publishDraftWithConfirm(ns);
      if (pubPrev.phase !== "preview" || !pubPrev.confirmationToken) throw new Error("publish preview expected");
      const pubCommit = await publishDraftWithConfirm(ns, { confirm: true, token: pubPrev.confirmationToken });
      if (pubCommit.phase !== "commit" || !pubCommit.ok) throw new Error("publish commit expected");
      expect(pubCommit.selfAuthored).toBe(true);

      // 3. force-cascade delete a chapter → new createDraft + apply(deleteNode).
      const delArgs = { nodeId: chapterToDelete.id, force: true };
      const pDel = await runGraphMutation({ namespace: ns, mutation: deleteNode, args: delArgs });
      if (pDel.phase !== "preview") throw new Error(`delete preview expected, got ${pDel.phase}`);
      await runGraphMutation({ namespace: ns, mutation: deleteNode, args: delArgs, confirm: true, token: pDel.confirmationToken });

      // 4. discard the current draft → discard.
      const disPrev = await discardDraftWithConfirm(ns);
      if (disPrev.phase !== "preview" || !disPrev.confirmationToken) throw new Error("discard preview expected");
      await discardDraftWithConfirm(ns, { confirm: true, token: disPrev.confirmationToken });

      // 5. a curator-publish denial → blocked (unauthorized), attributed to the curator.
      await runAsActor(CURATOR, async () => { await publishDraftWithConfirm(ns); });

      // 6. a guardrail block (Rule 1: id is immutable) → blocked.
      const rename: GraphMutation<{ nodeId: string; newId: string }> = {
        name: "test/rename",
        describe: (a) => `rename '${a.nodeId}'`,
        apply: (base, args) => ({
          nodes: base.nodes.map((n) => (n.id === args.nodeId ? { ...n, id: args.newId } : n)),
          edges: base.edges.map((e) => ({ ...e, from: e.from === args.nodeId ? args.newId : e.from, to: e.to === args.nodeId ? args.newId : e.to })),
        }),
      };
      const blockedRename = await runGraphMutation({ namespace: ns, mutation: rename, args: { nodeId: editTarget.id, newId: "iri:renamed" } });
      expect(blockedRename.phase).toBe("blocked");

      // 7. seed one recipe apply record (recipe WRITING is #14's concern).
      await store.appendAudit(rec({
        id: "recipe-1", ts: "2026-07-31T00:00:00Z", eventType: "apply", mutation: "add_lesson",
        baseVersion: "vr0", resultingVersion: "vr1",
        diff: { nodes: { added: [{ id: "lesson-new", after: { title: "New lesson" } }], removed: [], changed: [] }, edges: { added: [], removed: [], changed: [] } },
        actor: toAuditActor(APPROVER),
      }));
    });

    // ── Read it all back THROUGH the tool, in detail, as the approver. ──
    const out = await inTarget(APPROVER, () => readAudit({ limit: 100, mode: "detail" }));
    const records = out.records as AuditRecord[];
    const byType = (t: string) => records.filter((r) => r.eventType === t);

    // Every event kind present.
    expect(byType("apply").length).toBeGreaterThanOrEqual(3);     // upsert + deleteNode + recipe
    expect(byType("createDraft").length).toBeGreaterThanOrEqual(2); // lazy on the 1st apply and again after publish
    expect(byType("publish")).toHaveLength(1);
    expect(byType("discard")).toHaveLength(1);
    expect(byType("blocked").length).toBeGreaterThanOrEqual(2);    // curator denial + guardrail

    // Publish carries the self-authorship flag and is attributed to the approver.
    const publish = byType("publish")[0];
    expect(publish.selfAuthored).toBe(true);
    expect(publish.actor.id).toBe(APPROVER.id);
    expect(publish.actor.role).toBe("approver");

    // The force-cascade delete removed a subtree (its diff has removed nodes).
    const del = byType("apply").find((r) => r.mutation === "deleteNode")!;
    expect(del).toBeDefined();
    expect(del.diff!.nodes.removed.length).toBeGreaterThanOrEqual(1);

    // The recipe event reads back, attributed.
    const recipe = byType("apply").find((r) => r.mutation === "add_lesson")!;
    expect(recipe).toBeDefined();
    expect(recipe.actor.id).toBe(APPROVER.id);

    // The curator-publish denial is attributed to the CURATOR, reason unauthorized.
    const curatorDenial = byType("blocked").find((r) => r.actor.id === CURATOR.id)!;
    expect(curatorDenial).toBeDefined();
    expect(curatorDenial.actor.role).toBe("curator");
    expect(curatorDenial.reason).toMatch(/unauthorized/);

    // The guardrail block is present with the Rule-1 reason.
    expect(byType("blocked").some((r) => (r.reason ?? "").includes("Rule 1"))).toBe(true);

    // Filtering that same session by outcome cleanly separates blocked from applied.
    const blockedOnly = await inTarget(APPROVER, () => readAudit({ outcome: "blocked", mode: "detail" }));
    expect((blockedOnly.records as AuditRecord[]).every((r) => r.eventType === "blocked")).toBe(true);
  });
});
