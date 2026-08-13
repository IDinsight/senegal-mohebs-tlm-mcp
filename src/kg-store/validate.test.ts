/*
 * Structural write-safety rules — direct + framework-integration tests
 *
 * Two rules:
 *   Rule 1 (id-immutable): no silent rename of a node/edge.
 *   Rule 2 (no-orphan): every edge points at nodes that exist.
 * These tests do two things:
 *   1. Call validateStructural directly with crafted before/after graphs, so
 *      the rules are covered even though no real edit tool exists yet.
 *   2. Drive them through runGraphMutation via a couple of internal test-only
 *      mutations, so the "errors block confirmation" path in #5 fires for the
 *      first time (previously unreachable because validate was empty).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../config.js";
import { listAvailableContexts, subjectDir, newSessionState, runInSession } from "../context/index.js";
import { resolveAdapter } from "../adapters/index.js";
import { serializeModel } from "../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, validateStructural, __resetMutationsForTest,
} from "./index.js";
import { __setStorageForTest } from "../storage/index.js";
import type { GraphMutation, MutationGraph } from "./index.js";
import type { KgNodeStore, StoredMeta } from "./types.js";
import type { StorageAdapter, HistoryFile } from "../types.js";
import { __setActorForTest, type Actor } from "../actor.js";

// Tests here exercise the structural rules under a curator actor — #8's
// authz gate blocks unknown/no-role actors from mutating.
const TEST_CURATOR: Actor = { id: "test-curator-uid", email: "curator@test", role: "curator", unknown: false };

// Storage stub — same shape the other kg-store tests use.
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

// A tiny hand-authored graph — easier to reason about than the real KG when
// crafting rename / dangling scenarios. Two chapters linked by a buildsTowards
// edge, one lesson under each. The exact shape doesn't matter — only that
// there are enough edges to make the rules non-trivial.
const NS_TEST = "test-ns";
const N = (id: string, extra: Partial<{ properties: Record<string, unknown>; type: string }> = {}) =>
  ({ id, type: extra.type ?? "chapter", namespace: NS_TEST, properties: extra.properties ?? {} });
const E = (id: string, from: string, to: string, type = "hasChild") =>
  ({ id, type, from, to, namespace: NS_TEST, properties: {} });

const sampleGraph = (): MutationGraph => ({
  nodes: [
    N("iri:chapter-1", { properties: { chapitreNum: 1, title: "Chapter 1" } }),
    N("iri:chapter-2", { properties: { chapitreNum: 2, title: "Chapter 2" } }),
    N("iri:lesson-1a", { type: "lesson", properties: { title: "Lesson 1a" } }),
    N("iri:lesson-2a", { type: "lesson", properties: { title: "Lesson 2a" } }),
  ],
  edges: [
    E("hasChild:iri:chapter-1->iri:lesson-1a", "iri:chapter-1", "iri:lesson-1a"),
    E("hasChild:iri:chapter-2->iri:lesson-2a", "iri:chapter-2", "iri:lesson-2a"),
    E("buildsTowards:iri:chapter-1->iri:chapter-2", "iri:chapter-1", "iri:chapter-2", "buildsTowards"),
  ],
});

// Deep copy so tests can mutate freely without cross-contamination.
const clone = <T>(g: T): T => JSON.parse(JSON.stringify(g));

describe("validateStructural — direct tests (Rule 1: id-immutable)", () => {
  it("passes when nothing changes", () => {
    const g = sampleGraph();
    expect(validateStructural(g, clone(g))).toEqual({ errors: [], warnings: [] });
  });

  it("passes when only content changes (title updated on an existing node)", () => {
    const before = sampleGraph();
    const after = clone(before);
    after.nodes[0].properties = { ...after.nodes[0].properties, title: "Chapter 1 (revised)" };
    expect(validateStructural(before, after)).toEqual({ errors: [], warnings: [] });
  });

  it("flags a node rename (same content under a new id)", () => {
    const before = sampleGraph();
    const after = clone(before);
    // Rename chapter-1 → chapter-XYZ, keep all its content. Also update the
    // incident edges so Rule 2 doesn't also fire — this test is about Rule 1
    // alone.
    after.nodes[0].id = "iri:chapter-XYZ";
    after.edges = after.edges.map((e) => ({
      ...e,
      from: e.from === "iri:chapter-1" ? "iri:chapter-XYZ" : e.from,
      to: e.to === "iri:chapter-1" ? "iri:chapter-XYZ" : e.to,
      // Edge ids are derived from (type, from, to); a rename that keeps the old
      // id would leave inconsistent edges. Give the incident edges fresh ids so
      // the test is only about the node rename.
      id: e.from === "iri:chapter-1" ? e.id.replace("iri:chapter-1", "iri:chapter-XYZ")
        : e.to === "iri:chapter-1" ? e.id.replace("iri:chapter-1", "iri:chapter-XYZ")
          : e.id,
    }));
    const result = validateStructural(before, after);
    expect(result.errors.some((e) => e.includes("Rule 1") && e.includes("iri:chapter-1") && e.includes("iri:chapter-XYZ"))).toBe(true);
  });

  it("does NOT flag a legitimate replace (different content under a different id)", () => {
    const before = sampleGraph();
    const after = clone(before);
    // Delete chapter-2 (and its incident edges), add a brand-new chapter-3
    // with genuinely different content. That's a replace, not a rename.
    after.nodes = after.nodes.filter((n) => n.id !== "iri:chapter-2");
    after.edges = after.edges.filter((e) => e.from !== "iri:chapter-2" && e.to !== "iri:chapter-2");
    after.nodes.push(N("iri:chapter-3", { properties: { chapitreNum: 3, title: "Totally Different Chapter" } }));
    // No edge touching lesson-2a would now dangle; remove that too so Rule 2
    // stays silent. (We already filtered lesson-2a's parent edge above.)
    after.nodes = after.nodes.filter((n) => n.id !== "iri:lesson-2a");
    const result = validateStructural(before, after);
    expect(result.errors).toEqual([]);
  });
});

describe("validateStructural — direct tests (Rule 2: no-orphan)", () => {
  it("passes when every edge's from/to resolves", () => {
    const g = sampleGraph();
    expect(validateStructural(g, clone(g)).errors).toEqual([]);
  });

  it("flags an edge whose 'from' node was removed", () => {
    const before = sampleGraph();
    const after = clone(before);
    // Remove chapter-1 but keep the edge that came from it — dangling.
    after.nodes = after.nodes.filter((n) => n.id !== "iri:chapter-1");
    const result = validateStructural(before, after);
    expect(result.errors.some((e) => e.includes("Rule 2") && e.includes("'from'") && e.includes("iri:chapter-1"))).toBe(true);
  });

  it("flags an edge whose 'to' node was removed", () => {
    const before = sampleGraph();
    const after = clone(before);
    // Remove lesson-2a but keep the hasChild edge pointing at it.
    after.nodes = after.nodes.filter((n) => n.id !== "iri:lesson-2a");
    const result = validateStructural(before, after);
    expect(result.errors.some((e) => e.includes("Rule 2") && e.includes("'to'") && e.includes("iri:lesson-2a"))).toBe(true);
  });

  it("does NOT flag a clean delete (node + all its incident edges gone together)", () => {
    const before = sampleGraph();
    const after = clone(before);
    // Proper delete: remove lesson-2a AND the edge that pointed at it.
    after.nodes = after.nodes.filter((n) => n.id !== "iri:lesson-2a");
    after.edges = after.edges.filter((e) => e.from !== "iri:lesson-2a" && e.to !== "iri:lesson-2a");
    expect(validateStructural(before, after).errors).toEqual([]);
  });

  it("flags a freshly-added edge that points at a nonexistent node", () => {
    const before = sampleGraph();
    const after = clone(before);
    after.edges.push(E("hasChild:iri:chapter-1->iri:ghost", "iri:chapter-1", "iri:ghost"));
    const result = validateStructural(before, after);
    expect(result.errors.some((e) => e.includes("Rule 2") && e.includes("iri:ghost"))).toBe(true);
  });
});

// ── Framework-integration tests ──────────────────────────────────────────────
// The above tests hit the shared function directly. Below we drive the same
// rules through runGraphMutation, so the "errors block confirmation" path in
// #5 — previously unreachable because validate was empty — is exercised.

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const firstCtx = contexts[0];
const ns = kgNamespace(firstCtx.grade, firstCtx.subject);

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

async function readPublishedGraph(namespace: string): Promise<MutationGraph> {
  const pointer = await store.readPointer(namespace);
  const slot = pointer!.publishedSlot;
  const [nodes, edges] = await Promise.all([store.listNodes(namespace, slot), store.listEdges(namespace, slot)]);
  const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}

// A mutation that deliberately renames one node to trigger Rule 1.
const renamingMutation: GraphMutation<{ nodeId: string; newId: string }> = {
  name: "test/rename-node",
  describe: (a) => `rename node '${a.nodeId}' to '${a.newId}'`,
  apply: (base, args) => ({
    // Preserve all content, only swap the id. Update incident edges' from/to so
    // Rule 2 stays silent — this mutation targets Rule 1 specifically.
    nodes: base.nodes.map((n) => (n.id === args.nodeId ? { ...n, id: args.newId } : n)),
    edges: base.edges.map((e) => ({
      ...e,
      from: e.from === args.nodeId ? args.newId : e.from,
      to: e.to === args.nodeId ? args.newId : e.to,
    })),
  }),
};

// A mutation that removes a node but leaves its incident edges behind — the
// classic Rule 2 trigger. Not a real "delete_node" (that's #12); the goal is
// only to exercise the check.
const orphanCreatingMutation: GraphMutation<{ nodeId: string }> = {
  name: "test/leave-dangling",
  describe: (a) => `remove node '${a.nodeId}' but leave its incident edges dangling`,
  apply: (base, args) => ({
    nodes: base.nodes.filter((n) => n.id !== args.nodeId),
    edges: base.edges, // deliberately don't clean up
  }),
};

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

describe("write-safety rules through the mutation framework", () => {
  it("Rule 1 blocks confirmation on a rename attempt — no token issued", async () => {
    const before = await readPublishedGraph(ns);
    const target = before.nodes[0];
    const result = await runInSession(newSessionState(), () =>
      runGraphMutation({
        namespace: ns, mutation: renamingMutation,
        args: { nodeId: target.id, newId: "iri:renamed-target" },
      }),
    );
    // Blocked: phase is "blocked", errors mention Rule 1, no token.
    if (result.phase !== "blocked") throw new Error(`expected blocked, got ${result.phase}`);
    expect(result.errors.some((e) => e.includes("Rule 1"))).toBe(true);
    expect("confirmationToken" in result).toBe(false);
    // No state change: no draft created, pointer unchanged.
    expect((await store.readPointer(ns))?.draftSlot).toBe(null);
  });

  it("Rule 2 blocks confirmation when a mutation would leave a dangling edge", async () => {
    const before = await readPublishedGraph(ns);
    // Pick a node that IS an edge target so removing it dangles at least one edge.
    const targeted = before.edges[0].to;
    const result = await runInSession(newSessionState(), () =>
      runGraphMutation({
        namespace: ns, mutation: orphanCreatingMutation,
        args: { nodeId: targeted },
      }),
    );
    if (result.phase !== "blocked") throw new Error(`expected blocked, got ${result.phase}`);
    expect(result.errors.some((e) => e.includes("Rule 2"))).toBe(true);
    expect("confirmationToken" in result).toBe(false);
  });

  it("a benign content-only edit still passes through structural rules cleanly", async () => {
    const before = await readPublishedGraph(ns);
    // Define inline: set a property on an existing node — no id change, no
    // node removal. Both rules should stay silent.
    const setTitle: GraphMutation<{ nodeId: string; title: string }> = {
      name: "test/set-title",
      describe: (a) => `set title on '${a.nodeId}'`,
      apply: (base, args) => ({
        nodes: base.nodes.map((n) => (n.id === args.nodeId ? { ...n, properties: { ...n.properties, title: args.title } } : n)),
        edges: base.edges,
      }),
    };
    const preview = await runInSession(newSessionState(), () =>
      runGraphMutation({ namespace: ns, mutation: setTitle, args: { nodeId: before.nodes[0].id, title: "Revised title" } }),
    );
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    // Token issued, diff produced, no warnings emitted.
    expect(typeof preview.confirmationToken).toBe("string");
    expect(preview.warnings).toEqual([]);
    expect(preview.diff.nodes.changed).toHaveLength(1);
  });

  it("structural rules and mutation-specific validate compose (both fire together)", async () => {
    // A mutation that BOTH renames a node AND fails its own validate. The
    // framework should surface errors from both layers.
    const before = await readPublishedGraph(ns);
    const compositeMutation: GraphMutation<{ nodeId: string; newId: string }> = {
      name: "test/rename-and-custom-check",
      describe: (a) => `rename ${a.nodeId} to ${a.newId} with a custom check`,
      validate: () => ({ errors: ["custom check failed on purpose"], warnings: [] }),
      apply: renamingMutation.apply,
    };
    const result = await runInSession(newSessionState(), () =>
      runGraphMutation({
        namespace: ns, mutation: compositeMutation,
        args: { nodeId: before.nodes[0].id, newId: "iri:renamed" },
      }),
    );
    if (result.phase !== "blocked") throw new Error(`expected blocked`);
    expect(result.errors.some((e) => e.includes("Rule 1"))).toBe(true);
    expect(result.errors.some((e) => e.includes("custom check failed on purpose"))).toBe(true);
  });

  it("published reads stay structurally identical after a blocked mutation (parity oracle)", async () => {
    // A blocked mutation should be a genuine no-op — nothing about the store
    // should be observably different. This piggybacks on #2's parity oracle.
    async function reads(): Promise<unknown> {
      const state = newSessionState();
      return runInSession(state, async () => {
        const { activateContext } = await import("../activate.js");
        const r = await activateContext(firstCtx.workspace, firstCtx.grade, firstCtx.subject);
        if (!r.ok) throw new Error(r.error);
        const adapter = resolveAdapter(firstCtx.grade, firstCtx.subject)!;
        return { units: adapter.listUnits(), scopes: adapter.scopeValues() };
      });
    }
    const before = await reads();
    const g = await readPublishedGraph(ns);
    await runGraphMutation({
      namespace: ns, mutation: renamingMutation,
      args: { nodeId: g.nodes[0].id, newId: "iri:should-be-blocked" },
    });
    const after = await reads();
    expect(after).toEqual(before);
  });
});
