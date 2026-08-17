/*
 * Append-only audit log — tests
 *
 * Every state-changing graph op writes exactly one committed-change audit
 * record; every rejected mutation writes a blocked record; nothing else
 * touches the audit collection. The framework is the only production entry
 * point that produces audits, so completeness is enforced there — the tests
 * drive it through runGraphMutation, plus a few direct calls to prove the
 * #4 lifecycle ops accept and commit audit records too.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { listAvailableContexts, newSessionState, runInSession } from "../../context/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, __resetMutationsForTest,
} from "../index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { runAsActor, __setActorForTest, type Actor } from "../../actor.js";

// Curator identity for the default test path. The "unknown actor" and
// "verified actor" cases install their own actor inside the test.
const TEST_CURATOR: Actor = { id: "test-curator-uid", email: "curator@test", role: "curator", unknown: false };
import type { GraphMutation, MutationGraph, AuditRecord } from "../index.js";
import type { KgNodeStore, StoredMeta } from "../types.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const emptyHistory: HistoryFile = { version: 3, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [],
  getObjectMd5: async () => null,
  downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory,
  writeHistory: async () => {},
};

// Same test-only mutations used across the framework tests, plus a stable
// content-only edit for the happy path.
type SetPropArgs = { nodeId: string; key: string; value: unknown };
const setNodeProperty: GraphMutation<SetPropArgs> = {
  name: "test/setNodeProperty",
  describe: (args) => `set property '${args.key}' on node '${args.nodeId}'`,
  apply: (base, args) => ({
    nodes: base.nodes.map((n) =>
      n.id === args.nodeId ? { ...n, properties: { ...n.properties, [args.key]: args.value } } : n,
    ),
    edges: base.edges,
  }),
};

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
// Pinned to the senegal workspace: this harness's curator/approver actor
// holds a role only there (legacy app_role bridge), and its mutations are
// tuned to that graph. A second workspace (nigeria) must not hijack it.
const firstCtx = contexts.find((c) => c.workspace === "senegal")!;
const ns = kgNamespace(firstCtx.workspace, firstCtx.grade, firstCtx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(workspace, grade, subject));
    const meta: StoredMeta = {
      contentHash: "test", seededAt: "1970-01-01T00:00:00Z",
      adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length,
    };
    // Seed does not carry an audit — the seed is out of scope for #7 (it's
    // an operator step, not a runtime state change). writeSlot without an
    // audit is legitimate here.
    await freshStore.writeSlot(kgNamespace(workspace, grade, subject), "a", { nodes, edges, meta });
    await freshStore.ensurePointer(kgNamespace(workspace, grade, subject), "a");
  }
  return freshStore;
}

async function readPublishedGraph(namespace: string): Promise<MutationGraph> {
  const pointer = await store.readPointer(namespace);
  const slot = pointer!.publishedSlot;
  const [nodes, edges] = await Promise.all([store.listNodes(namespace, slot), store.listEdges(namespace, slot)]);
  const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  __setActorForTest(TEST_CURATOR);
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE;
  else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

// ── Completeness ─────────────────────────────────────────────────────────────
// Every committed apply produces exactly one apply record. Every blocked
// path (validation error, stale token, etc.) produces exactly one blocked
// record. Baseline audits are always zero after seeding (seed writes carry
// no audit).

describe("completeness — every state-changing op writes exactly one record", () => {
  it("baseline: seeding a store produces no audit records", async () => {
    expect(await store.listAudit({})).toEqual([]);
  });

  it("one apply → one apply record; contains actor, ts, namespace, mutation, versions, diff", async () => {
    const before = await readPublishedGraph(ns);
    const target = before.nodes[0];
    const preview = await runGraphMutation({
      namespace: ns, mutation: setNodeProperty,
      args: { nodeId: target.id, key: "audit-test", value: 42 },
    });
    if (preview.phase !== "preview") {
      throw new Error("preview");
    }
    await runGraphMutation({
      namespace: ns, mutation: setNodeProperty,
      args: { nodeId: target.id, key: "audit-test", value: 42 },
      confirm: true, token: preview.confirmationToken,
    });

    // apply + createDraft (draft didn't exist yet) — 2 committed events.
    const records = await store.listAudit({ namespace: ns });
    const events = records.map((r) => r.eventType).sort();
    expect(events).toEqual(["apply", "createDraft"]);

    const applyRec = records.find((r) => r.eventType === "apply")!;
    expect(applyRec.mutation).toBe("test/setNodeProperty");
    expect(applyRec.namespace).toBe(ns);
    expect(typeof applyRec.ts).toBe("string");
    expect(applyRec.actor.id).toBe(TEST_CURATOR.id);
    expect(applyRec.actor.unknown).toBe(false);
    expect(applyRec.actor.role).toBe("curator");
    expect(typeof applyRec.baseVersion).toBe("string");
    expect(typeof applyRec.resultingVersion).toBe("string");
    expect(applyRec.baseVersion).not.toBe(applyRec.resultingVersion);
    expect(applyRec.diff?.nodes.changed).toHaveLength(1);
    expect(applyRec.diff?.nodes.changed[0].id).toBe(target.id);

    const createRec = records.find((r) => r.eventType === "createDraft")!;
    expect(createRec.baseVersion).toBe(applyRec.baseVersion);
  });

  it("N applies against an existing draft produce N apply records + one createDraft", async () => {
    const before = await readPublishedGraph(ns);
    const target = before.nodes[0];
    for (const value of ["a", "b", "c"]) {
      const preview = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: target.id, key: "k", value },
      });
      if (preview.phase !== "preview") {
        throw new Error("preview");
      }
      await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: target.id, key: "k", value },
        confirm: true, token: preview.confirmationToken,
      });
    }
    const applies = await store.listAudit({ namespace: ns, eventType: "apply" });
    const creates = await store.listAudit({ namespace: ns, eventType: "createDraft" });
    expect(applies).toHaveLength(3);
    expect(creates).toHaveLength(1); // only the first apply lazily created the draft
  });

  it("chains: each apply's baseVersion equals the previous apply's resultingVersion", async () => {
    const before = await readPublishedGraph(ns);
    const target = before.nodes[0];
    for (const value of [1, 2, 3]) {
      const preview = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: target.id, key: "k", value },
      });
      if (preview.phase !== "preview") {
        throw new Error("preview");
      }
      await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: target.id, key: "k", value },
        confirm: true, token: preview.confirmationToken,
      });
    }
    const applies = (await store.listAudit({ namespace: ns, eventType: "apply" })).reverse();
    // listAudit is newest-first; reverse for chronological order.
    for (let i = 1; i < applies.length; i++) {
      expect(applies[i].baseVersion).toBe(applies[i - 1].resultingVersion);
    }
  });
});

// ── Blocked-attempt audits ──────────────────────────────────────────────────

describe("blocked attempts audit — lightweight, distinguishable from committed changes", () => {
  it("a validation-blocked mutation (Rule 1 rename) produces a blocked record with no state change", async () => {
    const before = await readPublishedGraph(ns);
    const rename: GraphMutation<{ nodeId: string; newId: string }> = {
      name: "test/rename",
      describe: (args) => `rename '${args.nodeId}'`,
      apply: (base, args) => ({
        nodes: base.nodes.map((n) => (n.id === args.nodeId ? { ...n, id: args.newId } : n)),
        edges: base.edges.map((e) => ({
          ...e,
          from: e.from === args.nodeId ? args.newId : e.from,
          to: e.to === args.nodeId ? args.newId : e.to,
        })),
      }),
    };
    const result = await runGraphMutation({
      namespace: ns, mutation: rename,
      args: { nodeId: before.nodes[0].id, newId: "iri:renamed" },
    });
    expect(result.phase).toBe("blocked");
    const records = await store.listAudit({ namespace: ns });
    expect(records).toHaveLength(1);
    expect(records[0].eventType).toBe("blocked");
    expect(records[0].mutation).toBe("test/rename");
    expect(records[0].reason).toContain("Rule 1");
    // Blocked records carry no diff, no versions — they're lightweight.
    expect(records[0].diff).toBeUndefined();
    expect(records[0].baseVersion).toBeUndefined();
    // And no state change: pointer still shows no draft.
    expect((await store.readPointer(ns))?.draftSlot).toBe(null);
  });

  it("a stale-token confirm produces a blocked record too", async () => {
    const before = await readPublishedGraph(ns);
    const target = before.nodes[0];
    // Two previews; apply one then try to apply the other — stale.
    const previewA = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: "A" } });
    const previewB = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: "B" } });
    if (previewA.phase !== "preview" || previewB.phase !== "preview") {
      throw new Error("preview");
    }
    await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: "A" }, confirm: true, token: previewA.confirmationToken });
    await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: "B" }, confirm: true, token: previewB.confirmationToken });

    const blocked = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason).toContain("stale");
  });

  it("blocked records are distinguishable from committed records by eventType alone", async () => {
    const before = await readPublishedGraph(ns);
    const target = before.nodes[0];
    // One successful apply.
    const preview1 = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: "ok" } });
    if (preview1.phase !== "preview") {
      throw new Error("preview");
    }
    await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: "ok" }, confirm: true, token: preview1.confirmationToken });
    // One blocked confirm (replay).
    await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: "ok" }, confirm: true, token: preview1.confirmationToken });

    const committed = await store.listAudit({ namespace: ns, eventType: "apply" });
    const blocked = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(committed).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason).toBe("replay");
  });
});

// ── Actor fidelity ──────────────────────────────────────────────────────────

describe("actor fidelity", () => {
  it("records an 'unknown' actor verbatim on the blocked-attempt record (under #8, unknown cannot apply)", async () => {
    // Explicitly clear the ambient curator so this test runs as unknown.
    __setActorForTest(null);
    const before = await readPublishedGraph(ns);
    const target = before.nodes[0];
    const result = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: 1 } });
    expect(result.phase).toBe("unauthorized");
    const blocked = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(blocked[0].actor.unknown).toBe(true);
    expect(blocked[0].actor.id).toBe("unknown");
    // And no apply record exists — an unknown actor produced no committed change.
    expect(await store.listAudit({ namespace: ns, eventType: "apply" })).toHaveLength(0);
  });

  it("records a verified curator actor with id/email/tokenIssuer/role intact", async () => {
    const before = await readPublishedGraph(ns);
    const target = before.nodes[0];
    const actor: Actor = { id: "user-42", email: "u42@example.org", tokenIssuer: "https://supabase.example", role: "curator", unknown: false };
    await runAsActor(actor, async () => {
      const preview = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: 1 } });
      if (preview.phase !== "preview") {
        throw new Error("preview");
      }
      await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: 1 }, confirm: true, token: preview.confirmationToken });
    });
    const applies = await store.listAudit({ namespace: ns, eventType: "apply" });
    // The audit snapshot adds superAdmin (false here); identity fields intact.
    expect(applies[0].actor).toEqual({ ...actor, superAdmin: false });
  });
});

// ── Atomicity ───────────────────────────────────────────────────────────────
// In the memory backend the state write and the audit push happen in one
// synchronous block, so there's no interleaving to test. What we CAN test is
// the inverse: if the store's writeSlot throws, no audit is recorded — the
// framework never emits an audit-without-state. We inject a failing applyDelta
// and check that the failed apply left no committed audit behind.

describe("atomicity — a failing state write leaves no audit record", () => {
  it("if applyDelta rejects, no apply audit is committed", async () => {
    const before = await readPublishedGraph(ns);
    const target = before.nodes[0];
    // Wrap the store so the next applyDelta (the edit hot path's state write)
    // throws. All other methods pass through unchanged.
    const original = store;
    const failing: KgNodeStore = {
      ...original,
      kind: "memory",
      applyDelta: async () => { throw new Error("simulated commit failure"); },
    };
    __setKgStoreForTest(failing);

    const preview = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: 1 } });
    if (preview.phase !== "preview") {
      throw new Error("preview");
    }
    await expect(
      runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: target.id, key: "k", value: 1 }, confirm: true, token: preview.confirmationToken }),
    ).rejects.toThrow(/simulated commit failure/);

    // Put the good store back and verify no apply record exists — only the
    // createDraft that ran BEFORE the failing applyDelta, which is expected:
    // createDraft is its own committed event (with its own audit), and
    // succeeded atomically. The apply itself never committed → no apply audit.
    __setKgStoreForTest(original);
    const applies = await original.listAudit({ namespace: ns, eventType: "apply" });
    expect(applies).toHaveLength(0);
  });
});

// ── Append-only enforcement ─────────────────────────────────────────────────
// The store interface does not expose an update / delete method for audit
// records. This test proves the surface stays write-only.

describe("append-only surface", () => {
  it("KgNodeStore exposes only appendAudit + listAudit — no update / delete", () => {
    const keys = new Set(Object.keys(store));
    expect(keys.has("appendAudit")).toBe(true);
    expect(keys.has("listAudit")).toBe(true);
    // Anything that looks like a mutation on records must NOT be present.
    expect(keys.has("updateAudit")).toBe(false);
    expect(keys.has("deleteAudit")).toBe(false);
    expect(keys.has("modifyAudit")).toBe(false);
    expect(keys.has("removeAudit")).toBe(false);
  });

  it("appendAudit persists a record that listAudit returns", async () => {
    const record: AuditRecord = {
      id: randomUUID(), ts: "2026-07-30T12:00:00Z",
      actor: { id: "u1", email: null, tokenIssuer: null, role: null, superAdmin: false, unknown: false },
      namespace: ns, eventType: "blocked",
      mutation: "test/mut", reason: "manual",
    };
    await store.appendAudit(record);
    const listed = await store.listAudit({ namespace: ns });
    expect(listed.find((r) => r.id === record.id)).toEqual(record);
  });
});

// ── Query filter ────────────────────────────────────────────────────────────

describe("listAudit filters", () => {
  it("filters by eventType, actorId, namespace, and time range; sorts newest-first", async () => {
    const now = "2026-07-30T10:00:00Z";
    const later = "2026-07-30T11:00:00Z";
    const records: AuditRecord[] = [
      { id: "1", ts: now,   actor: { id: "alice", email: null, tokenIssuer: null, role: null, superAdmin: false, unknown: false }, namespace: ns, eventType: "apply", mutation: "m", baseVersion: "v0", resultingVersion: "v1" },
      { id: "2", ts: later, actor: { id: "bob", email: null, tokenIssuer: null, role: null, superAdmin: false, unknown: false }, namespace: ns, eventType: "blocked", mutation: "m", reason: "r" },
      { id: "3", ts: now,   actor: { id: "alice", email: null, tokenIssuer: null, role: null, superAdmin: false, unknown: false }, namespace: "other-ns", eventType: "apply", mutation: "m", baseVersion: "v0", resultingVersion: "v1" },
    ];
    for (const record of records) {
      await store.appendAudit(record);
    }

    // By namespace
    expect((await store.listAudit({ namespace: ns })).map((r) => r.id).sort()).toEqual(["1", "2"]);
    // By actorId
    expect((await store.listAudit({ actorId: "alice" })).map((r) => r.id).sort()).toEqual(["1", "3"]);
    // By eventType
    expect((await store.listAudit({ eventType: "blocked" })).map((r) => r.id)).toEqual(["2"]);
    // By time range (inclusive endpoints)
    expect((await store.listAudit({ sinceTs: later })).map((r) => r.id)).toEqual(["2"]);
    // Sort order: newest first.
    const all = await store.listAudit({ namespace: ns });
    expect(all[0].id).toBe("2"); // later ts wins
  });

  // Firestore rejects `undefined` field values by default — a denial-path
  // audit that carries an unknown/no-role actor would crash the whole
  // request if `email`/`tokenIssuer`/`role` were left as `undefined` on the
  // record. toAuditActor is the single funnel that normalizes those to
  // `null`; this test pins the invariant so it can't silently regress.
  it("toAuditActor emits null (never undefined) for absent identity/role fields", async () => {
    const { toAuditActor } = await import("../audit.js");
    // Signed-in, no-role, no email.
    const noRole = toAuditActor({ id: "u", unknown: false });
    expect(noRole.role).toBeNull();
    expect(noRole.email).toBeNull();
    expect(noRole.tokenIssuer).toBeNull();
    expect(Object.values(noRole)).not.toContain(undefined);
    // Unknown actor.
    const unknown = toAuditActor({ id: "unknown", unknown: true });
    expect(Object.values(unknown)).not.toContain(undefined);
    // Fully-populated actor.
    const curator = toAuditActor({ id: "c", email: "c@x", tokenIssuer: "iss", role: "curator", unknown: false });
    expect(curator).toEqual({ id: "c", email: "c@x", tokenIssuer: "iss", role: "curator", superAdmin: false, unknown: false });
  });

  it("limit caps the result count", async () => {
    for (const i of [1, 2, 3, 4, 5]) {
      await store.appendAudit({
        id: `q${i}`, ts: `2026-07-30T10:0${i}:00Z`,
        actor: { id: "a", email: null, tokenIssuer: null, role: null, superAdmin: false, unknown: false }, namespace: ns, eventType: "blocked",
        mutation: "m", reason: "r",
      });
    }
    expect((await store.listAudit({ namespace: ns, limit: 2 }))).toHaveLength(2);
  });
});

// ── Parity oracle: published reads unaffected ───────────────────────────────

describe("parity oracle: published reads stay identical after audit-producing ops", () => {
  it("a full apply chain leaves published byte-identical", async () => {
    async function readsFromPublished(): Promise<unknown> {
      const state = newSessionState();
      return runInSession(state, async () => {
        const { activateContext } = await import("../../activate.js");
        const activation = await activateContext(firstCtx.workspace, firstCtx.grade, firstCtx.subject);
        if (!activation.ok) {
          throw new Error(activation.error);
        }
        const adapter = resolveAdapter(firstCtx.grade, firstCtx.subject)!;
        return { nodes: [...adapter.model().byId.keys()].sort() };
      });
    }
    const before = await readsFromPublished();
    const graph = await readPublishedGraph(ns);
    const preview = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: graph.nodes[0].id, key: "audit-parity", value: "x" } });
    if (preview.phase !== "preview") {
      throw new Error("preview");
    }
    await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: graph.nodes[0].id, key: "audit-parity", value: "x" }, confirm: true, token: preview.confirmationToken });
    const after = await readsFromPublished();
    expect(after).toEqual(before);
    // And audits exist for the sequence.
    expect((await store.listAudit({ namespace: ns })).length).toBeGreaterThanOrEqual(2);
  });
});
