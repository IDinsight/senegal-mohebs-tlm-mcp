// ── #12 structural primitives — tests ────────────────────────────────────────
// Drives create_node / link_nodes / unlink_nodes / delete_node through the
// #5 framework end to end. Acceptance criteria mirror the task spec:
//
//   • create_node MINTS the id; a caller-supplied id in properties is
//     hard-rejected.
//   • link_nodes creates an edge; rejects endpoint missing (Rule 2), rejects
//     an edge type not observed on this namespace (LC-legality-lite), rejects
//     a duplicate edge.
//   • unlink_nodes removes an edge; enables the manual detach-then-delete
//     flow.
//   • delete_node deletes an ISOLATED node; rejects (Rule 2 / early Rule-2
//     mirror) when incident edges survive; does NOT cascade.
//   • Rule 1 (id-immutable) rename-detection FIRES across a delete_node +
//     create_node sequence on the same draft (published-reference check).
//   • Role matrix per primitive (curator/approver ok; no-role/unknown blocked
//     with a `blocked` audit record + no state change + no token).
//   • Audit fires on writes (event=apply) AND denials (event=blocked).
//   • End-to-end: create chapter node → create lesson node → link them →
//     diff_draft shows the whole → publish_draft flips them live atomically.
//   • Parity: untouched published reads unchanged.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../config.js";
import { listAvailableContexts, subjectDir, newSessionState, runInSession } from "../context/index.js";
import { resolveAdapter } from "../adapters/index.js";
import { serializeModel } from "../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, publishDraftWithConfirm, diffDraft,
  createNode, linkNodes, unlinkNodes, deleteNode, mintNodeId,
  __resetMutationsForTest, __resetDraftTokensForTest,
} from "./index.js";
import { edgeId as makeEdgeId } from "../curriculum/index.js";
import { __setStorageForTest } from "../storage/index.js";
import { runAsActor, __setActorForTest, type Actor } from "../actor.js";
import type { MutationGraph } from "./index.js";
import type { KgNodeStore, StoredMeta } from "./types.js";
import type { StorageAdapter, HistoryFile, WordingAliases } from "../types.js";

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

const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };
const APPROVER: Actor = { id: "approver-uid", email: "approver@test", role: "approver", unknown: false };
const SIGNED_IN_NO_ROLE: Actor = { id: "guest-uid", email: "guest@test", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const ns = kgNamespace(targetCtx.grade, targetCtx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(grade, subject), CONFIG.kgFile), "utf8"));
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

async function readSlotGraph(namespace: string, slot: "a" | "b"): Promise<MutationGraph> {
  const [nodes, edges] = await Promise.all([store.listNodes(namespace, slot), store.listEdges(namespace, slot)]);
  const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}

async function readPublishedGraph(namespace: string): Promise<MutationGraph> {
  const pointer = await store.readPointer(namespace);
  return readSlotGraph(namespace, pointer!.publishedSlot);
}

// The CI maths adapter's wordingAliases (read once here so tests don't depend
// on a specific adapter's static object).
const aliases = (): WordingAliases => resolveAdapter(targetCtx.grade, targetCtx.subject)!.wordingAliases;

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  __resetDraftTokensForTest();
  __setActorForTest(CURATOR);
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE;
  else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

// ── create_node ─────────────────────────────────────────────────────────────

describe("create_node", () => {
  it("mints a server-side id and creates the node on the DRAFT after confirm", async () => {
    const newNodeId = mintNodeId();
    const preview = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "New chapter", raw: { chapitreNum: 999 } }, namespace: ns, aliases: aliases(), newNodeId },
    });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    // The diff surfaces the added node with the minted id.
    expect(preview.diff.nodes.added.map((n) => n.id)).toContain(newNodeId);

    const applied = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "New chapter", raw: { chapitreNum: 999 } }, namespace: ns, aliases: aliases(), newNodeId },
      confirm: true, token: preview.confirmationToken,
    });
    expect(applied).toMatchObject({ ok: true });
    const draft = await readSlotGraph(ns, "b");
    expect(draft.nodes.some((n) => n.id === newNodeId && n.type === "chapter")).toBe(true);
    // Published is untouched.
    const published = await readSlotGraph(ns, "a");
    expect(published.nodes.some((n) => n.id === newNodeId)).toBe(false);
  });

  it("hard-rejects a caller-supplied id in properties (identity is server-minted)", async () => {
    const newNodeId = mintNodeId();
    const blocked = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: {
        kind: "chapter",
        properties: { title: "Rogue", id: "caller-supplied-id" },  // sneak in an id
        namespace: ns, aliases: aliases(), newNodeId,
      },
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("caller-supplied id"))).toBe(true);
    expect("confirmationToken" in blocked).toBe(false);
  });

  it("rejects an unknown kind (F3: LC-legality-lite via observed vocabulary)", async () => {
    const newNodeId = mintNodeId();
    const blocked = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "widget", properties: { text: "..." }, namespace: ns, aliases: aliases(), newNodeId },
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("not a known node kind"))).toBe(true);
  });

  it("warns (does not block) when the new node has no wording for its kind", async () => {
    const newNodeId = mintNodeId();
    const preview = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: {}, namespace: ns, aliases: aliases(), newNodeId },
    });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    // Token issued (warnings don't block); one warning names the missing keys.
    expect(typeof preview.confirmationToken).toBe("string");
    expect(preview.warnings.length).toBeGreaterThanOrEqual(1);
    expect(preview.warnings[0]).toMatch(/without wording/);
  });
});

// ── link_nodes ──────────────────────────────────────────────────────────────

describe("link_nodes", () => {
  it("adds an edge between two existing nodes", async () => {
    const g = await readPublishedGraph(ns);
    // Pick two chapters and link them with buildsTowards (a known edge type).
    const chapters = g.nodes.filter((n) => n.type === "chapter");
    const [a, b] = [chapters[0], chapters[chapters.length - 1]];
    // Choose a pair that isn't already linked.
    const existingId = makeEdgeId("buildsTowards", a.id, b.id);
    const targetPair = g.edges.some((e) => e.id === existingId)
      ? [chapters[1], chapters[chapters.length - 2]]
      : [a, b];
    const [from, to] = targetPair;

    const preview = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "buildsTowards", fromId: from.id, toId: to.id, properties: {}, namespace: ns },
    });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    const newId = makeEdgeId("buildsTowards", from.id, to.id);
    expect(preview.diff.edges.added.map((e) => e.id)).toContain(newId);

    const applied = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "buildsTowards", fromId: from.id, toId: to.id, properties: {}, namespace: ns },
      confirm: true, token: preview.confirmationToken,
    });
    expect(applied).toMatchObject({ ok: true });
    const draft = await readSlotGraph(ns, "b");
    expect(draft.edges.some((e) => e.id === newId)).toBe(true);
  });

  it("rejects when an endpoint does not exist (Rule 2 upstream + tool-level pre-check)", async () => {
    const g = await readPublishedGraph(ns);
    const real = g.nodes[0];
    const blocked = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "hasChild", fromId: real.id, toId: "iri:ghost", properties: {}, namespace: ns },
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("'to' node") && e.includes("iri:ghost"))).toBe(true);
  });

  it("rejects an unknown edge type (F3: LC-legality-lite via observed vocabulary)", async () => {
    const g = await readPublishedGraph(ns);
    const [a, b] = [g.nodes[0], g.nodes[1]];
    const blocked = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "hasLesson", fromId: a.id, toId: b.id, properties: {}, namespace: ns },  // hasLesson isn't a real edge type here
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("not a known edge type"))).toBe(true);
  });

  it("rejects a duplicate edge (same type, from, to already exists)", async () => {
    const g = await readPublishedGraph(ns);
    // Any existing hasChild edge is a valid duplicate target.
    const existing = g.edges.find((e) => e.type === "hasChild")!;
    const blocked = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: existing.type, fromId: existing.from, toId: existing.to, properties: {}, namespace: ns },
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("already exists"))).toBe(true);
  });

  it("rejects a self-loop", async () => {
    const g = await readPublishedGraph(ns);
    const node = g.nodes.find((n) => n.type === "chapter")!;
    const blocked = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "buildsTowards", fromId: node.id, toId: node.id, properties: {}, namespace: ns },
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("self-loop"))).toBe(true);
  });
});

// ── unlink_nodes ────────────────────────────────────────────────────────────

describe("unlink_nodes", () => {
  it("removes an existing edge", async () => {
    const g = await readPublishedGraph(ns);
    const edge = g.edges[0];
    const preview = await runGraphMutation({
      namespace: ns, mutation: unlinkNodes, args: { edgeId: edge.id },
    });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    expect(preview.diff.edges.removed.map((e) => e.id)).toContain(edge.id);

    const applied = await runGraphMutation({
      namespace: ns, mutation: unlinkNodes, args: { edgeId: edge.id },
      confirm: true, token: preview.confirmationToken,
    });
    expect(applied).toMatchObject({ ok: true });
    const draft = await readSlotGraph(ns, "b");
    expect(draft.edges.some((e) => e.id === edge.id)).toBe(false);
  });

  it("rejects when the edge id doesn't exist", async () => {
    const blocked = await runGraphMutation({
      namespace: ns, mutation: unlinkNodes, args: { edgeId: "no-such-edge" },
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("does not exist"))).toBe(true);
  });
});

// ── delete_node ─────────────────────────────────────────────────────────────

describe("delete_node — non-cascading", () => {
  it("deletes an ISOLATED node (no incident edges)", async () => {
    // Create + isolate a fresh node so we know it has no edges.
    const newNodeId = mintNodeId();
    const p1 = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "isolated" }, namespace: ns, aliases: aliases(), newNodeId },
    });
    if (p1.phase !== "preview") throw new Error("preview");
    await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "isolated" }, namespace: ns, aliases: aliases(), newNodeId },
      confirm: true, token: p1.confirmationToken,
    });

    // Now delete_node: the new node has no incident edges, so Rule 2 stays
    // silent and delete succeeds.
    const p2 = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: newNodeId },
    });
    if (p2.phase !== "preview") throw new Error(`expected preview, got ${p2.phase}`);
    const applied = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: newNodeId },
      confirm: true, token: p2.confirmationToken,
    });
    expect(applied).toMatchObject({ ok: true });
    const draft = await readSlotGraph(ns, "b");
    expect(draft.nodes.some((n) => n.id === newNodeId)).toBe(false);
  });

  it("REFUSES to delete a node that still has incident edges (no cascade)", async () => {
    const g = await readPublishedGraph(ns);
    // Pick any node with an incident edge — a chapter with lessons will do.
    const targeted = g.edges[0].from;
    const blocked = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: targeted },
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("incident edge") && e.includes("does not cascade"))).toBe(true);
  });

  it("delete-then-unlink flow works when unlinks come first", async () => {
    // Find a node with exactly two incident edges to make the test small.
    const g = await readPublishedGraph(ns);
    const counts = new Map<string, number>();
    for (const e of g.edges) {
      counts.set(e.from, (counts.get(e.from) ?? 0) + 1);
      counts.set(e.to, (counts.get(e.to) ?? 0) + 1);
    }
    const targetId = [...counts.entries()].sort((a, b) => a[1] - b[1]).find(([, n]) => n >= 1)![0];
    const incident = g.edges.filter((e) => e.from === targetId || e.to === targetId);

    // Unlink each incident edge in its own mutation (per-mutation confirm, as
    // the framework requires).
    for (const e of incident) {
      const p = await runGraphMutation({ namespace: ns, mutation: unlinkNodes, args: { edgeId: e.id } });
      if (p.phase !== "preview") throw new Error("preview");
      await runGraphMutation({
        namespace: ns, mutation: unlinkNodes, args: { edgeId: e.id },
        confirm: true, token: p.confirmationToken,
      });
    }
    // Now delete_node should succeed.
    const p = await runGraphMutation({ namespace: ns, mutation: deleteNode, args: { nodeId: targetId } });
    if (p.phase !== "preview") throw new Error(`expected preview after unlinks, got ${p.phase}`);
    const applied = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: targetId },
      confirm: true, token: p.confirmationToken,
    });
    expect(applied).toMatchObject({ ok: true });
  });
});

// ── Rule 1 (headline): disguised rename detected across delete + create ──────

describe("Rule 1 — disguised rename across delete_node + create_node", () => {
  it("blocks a create_node whose content matches a deleted node's, even with a new id", async () => {
    // 1. Pick a real chapter and capture its content.
    const g = await readPublishedGraph(ns);
    // Pick a chapter that has incident edges (all seeded chapters do). Unlink
    // them so delete_node passes Rule 2 for this test; Rule 1 is what we're
    // exercising here, not Rule 2.
    const chapter = g.nodes.find((n) => n.type === "chapter")!;
    const incident = g.edges.filter((e) => e.from === chapter.id || e.to === chapter.id);
    for (const e of incident) {
      const p = await runGraphMutation({ namespace: ns, mutation: unlinkNodes, args: { edgeId: e.id } });
      if (p.phase !== "preview") throw new Error("preview");
      await runGraphMutation({
        namespace: ns, mutation: unlinkNodes, args: { edgeId: e.id },
        confirm: true, token: p.confirmationToken,
      });
    }
    // 2. delete_node.
    const pDelete = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: chapter.id },
    });
    if (pDelete.phase !== "preview") throw new Error(`delete preview expected, got ${pDelete.phase}`);
    await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: chapter.id },
      confirm: true, token: pDelete.confirmationToken,
    });

    // 3. Now try to create_node with the SAME content under a NEW id.
    // Extract the content the way the node stored it.
    const newNodeId = mintNodeId();
    const blocked = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: {
        kind: chapter.type,
        properties: { ...(chapter.properties as Record<string, unknown>) },  // identical content
        namespace: ns, aliases: aliases(), newNodeId,
      },
    });
    // Rule 1 fires because the PUBLISHED reference still contains the
    // deleted node (published hasn't moved), and after our proposed
    // apply, the new node has matching content under a different id.
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("Rule 1") && e.includes(chapter.id) && e.includes(newNodeId))).toBe(true);
  });

  it("does NOT block a create_node with substantively different content (legitimate replace)", async () => {
    const newNodeId = mintNodeId();
    const preview = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: {
        kind: "chapter",
        properties: { title: "A wholly new chapter", raw: { chapitreNum: 99999 } },
        namespace: ns, aliases: aliases(), newNodeId,
      },
    });
    // A brand-new distinct chapter is fine — no removed twin to match against.
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    expect(typeof preview.confirmationToken).toBe("string");
  });
});

// ── Role matrix ─────────────────────────────────────────────────────────────

describe("role matrix — every primitive gated on curator/approver", () => {
  const primitiveCalls: Array<[string, () => Promise<unknown>]> = [
    ["create_node", () => runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "x" }, namespace: ns, aliases: aliases(), newNodeId: mintNodeId() },
    })],
    ["link_nodes", async () => {
      // Read as an unaffected caller so authz denial doesn't short-circuit
      // BEFORE the mutation args need real ids; but the framework denies
      // right at the top — args are never inspected. Provide plausible ids
      // regardless (the test only checks the denial shape).
      return runGraphMutation({
        namespace: ns, mutation: linkNodes,
        args: { edgeType: "hasChild", fromId: "any", toId: "any2", properties: {}, namespace: ns },
      });
    }],
    ["unlink_nodes", () => runGraphMutation({
      namespace: ns, mutation: unlinkNodes, args: { edgeId: "any" },
    })],
    ["delete_node", () => runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: "any" },
    })],
  ];

  for (const [name, call] of primitiveCalls) {
    it(`${name}: signed-in-no-role is denied cleanly (no token, no state, blocked audit)`, async () => {
      const auditBefore = (await store.listAudit({ namespace: ns })).length;
      const pointerBefore = await store.readPointer(ns);
      const result = await runAsActor(SIGNED_IN_NO_ROLE, call);
      expect(result).toMatchObject({ phase: "unauthorized", action: "apply" });
      // No state change.
      expect(await store.readPointer(ns)).toEqual(pointerBefore);
      // Blocked audit written.
      const auditAfter = await store.listAudit({ namespace: ns });
      expect(auditAfter.length).toBe(auditBefore + 1);
      expect(auditAfter[0]).toMatchObject({ eventType: "blocked" });
      expect(auditAfter[0].reason).toMatch(/^unauthorized:/);
    });

    it(`${name}: curator is permitted (reaches preview/blocked from validate, not authz)`, async () => {
      const result = await runAsActor(CURATOR, call);
      // Not "unauthorized". May be preview/blocked/apply — the point is the
      // authz gate does not stop a curator; whatever comes next is validation
      // territory, exercised elsewhere.
      expect((result as { phase: string }).phase).not.toBe("unauthorized");
    });
  }
});

// ── Audit on writes ─────────────────────────────────────────────────────────

describe("audit — apply and blocked records", () => {
  it("a successful create_node writes an apply audit record with the diff", async () => {
    const auditBefore = (await store.listAudit({ namespace: ns, eventType: "apply" })).length;
    const newNodeId = mintNodeId();
    const p = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "audited" }, namespace: ns, aliases: aliases(), newNodeId },
    });
    if (p.phase !== "preview") throw new Error("preview");
    await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "audited" }, namespace: ns, aliases: aliases(), newNodeId },
      confirm: true, token: p.confirmationToken,
    });
    const applyRecs = await store.listAudit({ namespace: ns, eventType: "apply" });
    expect(applyRecs.length).toBe(auditBefore + 1);
    expect(applyRecs[0].mutation).toBe("createNode");
    expect(applyRecs[0].diff?.nodes.added.map((n) => n.id)).toContain(newNodeId);
  });

  it("a validate-blocked delete_node writes a blocked audit record with a reason", async () => {
    const g = await readPublishedGraph(ns);
    const targeted = g.edges[0].from;  // has incident edges → will be blocked
    const before = (await store.listAudit({ namespace: ns, eventType: "blocked" })).length;
    const blocked = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: targeted },
    });
    expect(blocked.phase).toBe("blocked");
    const after = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(after.length).toBe(before + 1);
    expect(after[0].mutation).toBe("deleteNode");
    expect(after[0].reason).toMatch(/^validation:/);
  });
});

// ── End-to-end: chapter + lesson + link → draft → publish → parity ──────────

describe("end-to-end: manual structural add across a draft, then publish", () => {
  it("accumulates create+create+link on one draft; publish flips them live atomically", async () => {
    // 1. Create a new chapter node.
    const chapterId = mintNodeId();
    const p1 = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "Nouveau chapitre", raw: { chapitreNum: 42, chapitreTitre: "Nouveau chapitre" } }, namespace: ns, aliases: aliases(), newNodeId: chapterId },
    });
    if (p1.phase !== "preview") throw new Error("chapter preview");
    await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "Nouveau chapitre", raw: { chapitreNum: 42, chapitreTitre: "Nouveau chapitre" } }, namespace: ns, aliases: aliases(), newNodeId: chapterId },
      confirm: true, token: p1.confirmationToken,
    });

    // 2. Create a lesson node.
    const lessonId = mintNodeId();
    const p2 = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "lesson", properties: { text: "Une nouvelle leçon", raw: { osTexte: "Une nouvelle leçon" } }, namespace: ns, aliases: aliases(), newNodeId: lessonId },
    });
    if (p2.phase !== "preview") throw new Error("lesson preview");
    await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "lesson", properties: { text: "Une nouvelle leçon", raw: { osTexte: "Une nouvelle leçon" } }, namespace: ns, aliases: aliases(), newNodeId: lessonId },
      confirm: true, token: p2.confirmationToken,
    });

    // 3. Link them — chapter hasChild lesson.
    const p3 = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "hasChild", fromId: chapterId, toId: lessonId, properties: { orderInParent: 0 }, namespace: ns },
    });
    if (p3.phase !== "preview") throw new Error("link preview");
    await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "hasChild", fromId: chapterId, toId: lessonId, properties: { orderInParent: 0 }, namespace: ns },
      confirm: true, token: p3.confirmationToken,
    });

    // diff_draft should now report all three changes together (whole-draft view).
    const draftDiff = await diffDraft(ns);
    expect(draftDiff.hasDraft).toBe(true);
    expect(draftDiff.diff!.nodes.added.map((n) => n.id).sort()).toEqual([chapterId, lessonId].sort());
    expect(draftDiff.diff!.edges.added.map((e) => e.id)).toContain(makeEdgeId("hasChild", chapterId, lessonId));

    // 4. Approver publishes atomically.
    const pubPreview = await runAsActor(APPROVER, () => publishDraftWithConfirm(ns));
    if (pubPreview.phase !== "preview") throw new Error(`publish preview expected, got ${pubPreview.phase}`);
    const pubCommit = await runAsActor(APPROVER, () => publishDraftWithConfirm(ns, { confirm: true, token: pubPreview.confirmationToken }));
    expect(pubCommit).toMatchObject({ phase: "commit", ok: true });

    // 5. Published now carries the new structure.
    const publishedAfter = await readPublishedGraph(ns);
    expect(publishedAfter.nodes.some((n) => n.id === chapterId)).toBe(true);
    expect(publishedAfter.nodes.some((n) => n.id === lessonId)).toBe(true);
    expect(publishedAfter.edges.some((e) => e.id === makeEdgeId("hasChild", chapterId, lessonId))).toBe(true);
  });
});

// ── Parity: untouched published reads are unchanged after a draft-only apply ─

describe("parity — a structural draft edit doesn't leak to published reads", () => {
  it("untouched publications look byte-identical to before the draft edit", async () => {
    const before = await readPublishedGraph(ns);
    // Create a floating node on the draft.
    const newNodeId = mintNodeId();
    const p = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "leak test" }, namespace: ns, aliases: aliases(), newNodeId },
    });
    if (p.phase !== "preview") throw new Error("preview");
    await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "leak test" }, namespace: ns, aliases: aliases(), newNodeId },
      confirm: true, token: p.confirmationToken,
    });
    const afterPublished = await readPublishedGraph(ns);
    expect(afterPublished).toEqual(before);
  });
});
