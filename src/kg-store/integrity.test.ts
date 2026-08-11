// ── #13 referential-integrity tests ─────────────────────────────────────────
// The block-vs-warn split, the explicit-force cascade, and coverage warnings.
//
//   • BLOCK (error, no token): a delete that would dangle an edge; a link to a
//     missing node. (Rule 2, extended coverage.)
//   • FORCE cascade: force=false refuses a connected node; force=true removes
//     the node + its dependent subtree + all incident edges in ONE mutation,
//     the dry-run diff shows the FULL set, and the result is integrity-clean.
//     Cascade never happens without explicit force.
//   • WARN (never blocks): coverage warnings fire on dry-run AND diff_draft for
//     the real CI maths rules (empty chapter, missing bilan, lesson >1 parent,
//     chapitreNum drift), but the edit stays confirmable and publishable.
//   • publish-with-warnings succeeds and records warningsAtPublish.
//   • role matrix + audit intact; parity green; regime-B (chapitreNum) warns.
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
import type { StorageAdapter, HistoryFile, GraphView } from "../types.js";

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

// The CI maths adapter's coverage hook as a callback — this is exactly what the
// server layer injects into runGraphMutation / diffDraft in production.
const coverage = (graph: MutationGraph): string[] =>
  resolveAdapter(targetCtx.grade, targetCtx.subject)!.coverageWarnings?.(graph as GraphView) ?? [];
const aliases = () => resolveAdapter(targetCtx.grade, targetCtx.subject)!.wordingAliases;

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

async function readSlot(namespace: string, slot: "a" | "b"): Promise<MutationGraph> {
  const [nodes, edges] = await Promise.all([store.listNodes(namespace, slot), store.listEdges(namespace, slot)]);
  const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}
async function readPublished(namespace: string): Promise<MutationGraph> {
  const p = await store.readPointer(namespace);
  return readSlot(namespace, p!.publishedSlot);
}

// Apply a mutation to the draft in two phases (dry-run → confirm). Returns the
// confirm result. Injects coverage so warnings flow exactly as in production.
async function apply<A>(mutation: any, args: A): Promise<any> {
  const preview = await runGraphMutation({ namespace: ns, mutation, args, coverage });
  if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}: ${JSON.stringify(preview)}`);
  return runGraphMutation({ namespace: ns, mutation, args, confirm: true, token: preview.confirmationToken, coverage });
}

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

// ── BLOCK layer: dangling references are refused ─────────────────────────────

describe("block: referential corruption is refused (error, no token)", () => {
  it("link to a missing node is blocked", async () => {
    const g = await readPublished(ns);
    const real = g.nodes[0];
    const blocked = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "hasChild", fromId: real.id, toId: "iri:ghost", properties: {}, namespace: ns },
      coverage,
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect("confirmationToken" in blocked).toBe(false);
  });

  it("plain delete of a connected node is blocked (Rule 2 / targeted error), no token", async () => {
    const g = await readPublished(ns);
    const connected = g.edges[0].from;
    const blocked = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: connected },
      coverage,
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("incident edge"))).toBe(true);
    expect("confirmationToken" in blocked).toBe(false);
    // No state change: no draft was created.
    expect((await store.readPointer(ns))?.draftSlot).toBe(null);
  });
});

// ── FORCE cascade ────────────────────────────────────────────────────────────

describe("delete_node force cascade", () => {
  it("force=false still refuses a connected node; error mentions the force option", async () => {
    const g = await readPublished(ns);
    const connected = g.edges[0].from;
    const blocked = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: connected, force: false },
      coverage,
    });
    if (blocked.phase !== "blocked") throw new Error(`expected blocked, got ${blocked.phase}`);
    expect(blocked.errors.some((e) => e.includes("force:true"))).toBe(true);
  });

  it("force=true cascades the whole dependent subtree + all incident edges atomically; dry-run shows the full set", async () => {
    const g = await readPublished(ns);
    // Pick a chapter with lessons (and hence components/tasks below them).
    const chapterWithChildren = g.nodes.find(
      (n) => n.type === "chapter" && g.edges.some((e) => e.type === "hasChild" && e.from === n.id),
    )!;

    // Compute the expected removed set by hand: chapter → its hasChild subtree.
    const childrenOf = (id: string) => g.edges.filter((e) => e.type === "hasChild" && e.from === id).map((e) => e.to);
    const expectedNodes = new Set<string>([chapterWithChildren.id]);
    const stack = [chapterWithChildren.id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of childrenOf(cur)) {
        // Only cascade if every hasChild parent of c is already in the set.
        const parents = g.edges.filter((e) => e.type === "hasChild" && e.to === c).map((e) => e.from);
        if (parents.every((p) => expectedNodes.has(p)) && !expectedNodes.has(c)) { expectedNodes.add(c); stack.push(c); }
      }
    }
    const expectedEdges = g.edges.filter((e) => expectedNodes.has(e.from) || expectedNodes.has(e.to)).map((e) => e.id);

    const preview = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: chapterWithChildren.id, force: true },
      coverage,
    });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    // Dry-run diff shows the FULL removed set — every subtree node and edge.
    const removedNodeIds = new Set(preview.diff.nodes.removed.map((n) => n.id));
    const removedEdgeIds = new Set(preview.diff.edges.removed.map((e) => e.id));
    expect([...expectedNodes].every((id) => removedNodeIds.has(id))).toBe(true);
    expect(removedNodeIds.size).toBe(expectedNodes.size);
    expect(expectedEdges.every((id) => removedEdgeIds.has(id))).toBe(true);

    const applied = await runGraphMutation({
      namespace: ns, mutation: deleteNode, args: { nodeId: chapterWithChildren.id, force: true },
      confirm: true, token: preview.confirmationToken, coverage,
    });
    expect(applied).toMatchObject({ ok: true });

    // Result is integrity-clean: no dangling edge in the draft.
    const draft = await readSlot(ns, "b");
    const nodeIds = new Set(draft.nodes.map((n) => n.id));
    for (const e of draft.edges) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
    // The whole subtree is gone.
    for (const id of expectedNodes) expect(nodeIds.has(id)).toBe(false);
  });

  it("force cascade drops a buildsTowards edge to a surviving neighbour but does NOT delete the neighbour", async () => {
    const g = await readPublished(ns);
    const bt = g.edges.find((e) => e.type === "buildsTowards")!;
    const neighbour = bt.to; // the chapter `from` builds towards
    // Force-delete the `from` chapter.
    const applied = await apply(deleteNode, { nodeId: bt.from, force: true });
    expect(applied).toMatchObject({ ok: true });
    const draft = await readSlot(ns, "b");
    // Neighbour survives; the buildsTowards edge is gone.
    expect(draft.nodes.some((n) => n.id === neighbour)).toBe(true);
    expect(draft.edges.some((e) => e.id === bt.id)).toBe(false);
  });
});

// ── WARN layer: coverage warnings fire but never block ───────────────────────

describe("coverage warnings — inform, never block", () => {
  it("emptying a chapter (unlinking its only bilan-less lesson set) surfaces warnings on the dry-run but stays confirmable", async () => {
    // Create a fresh chapter + one lesson, link them, then the chapter has a
    // lesson but (likely) no bilan → 'no bilan' warning; also we can then
    // unlink to empty it.
    const chapterId = mintNodeId();
    await apply(createNode, { kind: "chapter", properties: { title: "Cov chap", raw: { chapitreNum: 900, chapitreTitre: "Cov chap" } }, namespace: ns, aliases: aliases(), newNodeId: chapterId });
    const lessonId = mintNodeId();
    await apply(createNode, { kind: "lesson", properties: { text: "Cov lesson", raw: { osTexte: "Cov lesson", chapitreNum: 900 } }, namespace: ns, aliases: aliases(), newNodeId: lessonId });

    // Link them. The dry-run of THIS link should already warn: the chapter now
    // has a lesson but no bilan (isAssessment not set on the lesson).
    const preview = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "hasChild", fromId: chapterId, toId: lessonId, properties: { orderInParent: 0 }, namespace: ns },
      coverage,
    });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    // Token IS issued (warnings never block) and a bilan warning is present.
    expect(typeof preview.confirmationToken).toBe("string");
    expect(preview.warnings.some((w) => w.toLowerCase().includes("bilan"))).toBe(true);
    // And confirming still works.
    const applied = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "hasChild", fromId: chapterId, toId: lessonId, properties: { orderInParent: 0 }, namespace: ns },
      confirm: true, token: preview.confirmationToken, coverage,
    });
    expect(applied).toMatchObject({ ok: true });
  });

  it("a freshly created but unlinked chapter warns 'no child lessons' on dry-run", async () => {
    const chapterId = mintNodeId();
    const preview = await runGraphMutation({
      namespace: ns, mutation: createNode,
      args: { kind: "chapter", properties: { title: "Lonely", raw: { chapitreNum: 901, chapitreTitre: "Lonely" } }, namespace: ns, aliases: aliases(), newNodeId: chapterId },
      coverage,
    });
    if (preview.phase !== "preview") throw new Error("preview");
    expect(preview.warnings.some((w) => w.toLowerCase().includes("no child"))).toBe(true);
    expect(typeof preview.confirmationToken).toBe("string"); // not blocked
  });

  // (The old "chapitreNum drift (regime B)" warning is gone: chapter→lesson is a
  // real hasChild edge now, so there is no denormalized number that can drift.)

  it("lesson linked to two chapters warns (>1 chapter parent), still confirmable", async () => {
    // Reuse two real chapters, and a real lesson child of the first; link the
    // same lesson under a second chapter too.
    const g = await readPublished(ns);
    const parentEdge = g.edges.find((e) => e.type === "hasChild"
      && g.nodes.find((n) => n.id === e.from)?.type === "chapter"
      && g.nodes.find((n) => n.id === e.to)?.type === "lesson")!;
    const lessonId = parentEdge.to;
    const otherChapter = g.nodes.find((n) => n.type === "chapter" && n.id !== parentEdge.from)!;

    const preview = await runGraphMutation({
      namespace: ns, mutation: linkNodes,
      args: { edgeType: "hasChild", fromId: otherChapter.id, toId: lessonId, properties: {}, namespace: ns },
      coverage,
    });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    expect(preview.warnings.some((w) => w.includes("parents"))).toBe(true);
    expect(typeof preview.confirmationToken).toBe("string");
  });

  it("warnings appear on diff_draft (the approver's whole-draft view)", async () => {
    const chapterId = mintNodeId();
    await apply(createNode, { kind: "chapter", properties: { title: "Draft cov", raw: { chapitreNum: 904, chapitreTitre: "Draft cov" } }, namespace: ns, aliases: aliases(), newNodeId: chapterId });
    const whole = await diffDraft(ns, coverage);
    expect(whole.hasDraft).toBe(true);
    expect(Array.isArray(whole.warnings)).toBe(true);
    expect(whole.warnings!.some((w) => w.toLowerCase().includes("no child"))).toBe(true);
  });

  it("seed data with no draft edits produces NO coverage warnings (clean baseline)", async () => {
    // A benign wording-shaped edit on a real node shouldn't introduce coverage
    // warnings — the seed is complete.
    const g = await readPublished(ns);
    const chapter = g.nodes.find((n) => n.type === "chapter")!;
    const preview = await runGraphMutation({
      namespace: ns, mutation: upsertPropertyLike(chapter.id),
      args: {}, coverage,
    });
    if (preview.phase !== "preview") throw new Error("preview");
    expect(preview.warnings).toEqual([]);
  });
});

// A tiny inline mutation that touches only a node's non-structural property so
// the post-apply graph is still complete (used for the clean-baseline test).
function upsertPropertyLike(nodeId: string) {
  return {
    name: "test/touch",
    describe: () => `touch '${nodeId}'`,
    apply: (base: MutationGraph) => ({
      nodes: base.nodes.map((n) => (n.id === nodeId ? { ...n, properties: { ...n.properties, touched: true } } : n)),
      edges: base.edges,
    }),
  };
}

// ── publish with warnings ────────────────────────────────────────────────────

describe("publish proceeds with warnings and records warningsAtPublish", () => {
  it("an approver can publish a draft that has coverage warnings; the audit records them", async () => {
    // Curator creates a lonely chapter (warns 'no child lessons').
    const chapterId = mintNodeId();
    await apply(createNode, { kind: "chapter", properties: { title: "Publish-warn", raw: { chapitreNum: 905, chapitreTitre: "Publish-warn" } }, namespace: ns, aliases: aliases(), newNodeId: chapterId });

    // Approver dry-runs publish — warnings are shown but a token is still issued.
    const pubPreview = await runAsActor(APPROVER, () => publishDraftWithConfirm(ns, { coverage }));
    if (pubPreview.phase !== "preview") throw new Error(`expected preview, got ${pubPreview.phase}`);
    expect(pubPreview.warnings!.some((w) => w.toLowerCase().includes("no child"))).toBe(true);
    expect(typeof pubPreview.confirmationToken).toBe("string");

    // Confirm publishes despite warnings.
    const pubCommit = await runAsActor(APPROVER, () => publishDraftWithConfirm(ns, { confirm: true, token: pubPreview.confirmationToken, coverage }));
    expect(pubCommit).toMatchObject({ phase: "commit", ok: true });

    // The publish audit records the warnings that were present.
    const [publishRec] = await store.listAudit({ namespace: ns, eventType: "publish", limit: 1 });
    expect(publishRec).toBeDefined();
    expect(publishRec.warningsAtPublish?.some((w) => w.toLowerCase().includes("no child"))).toBe(true);

    // And it really went live.
    const published = await readPublished(ns);
    expect(published.nodes.some((n) => n.id === chapterId)).toBe(true);
  });
});

// ── Role matrix + audit for the force path ───────────────────────────────────

describe("force-delete respects the role gate + audit", () => {
  it("signed-in-no-role is denied a force delete (unauthorized, blocked audit, no state change)", async () => {
    const g = await readPublished(ns);
    const chapter = g.nodes.find((n) => n.type === "chapter")!;
    const before = (await store.listAudit({ namespace: ns })).length;
    const pointerBefore = await store.readPointer(ns);
    const result = await runAsActor(SIGNED_IN_NO_ROLE, () =>
      runGraphMutation({ namespace: ns, mutation: deleteNode, args: { nodeId: chapter.id, force: true }, coverage }),
    );
    expect(result).toMatchObject({ phase: "unauthorized" });
    expect(await store.readPointer(ns)).toEqual(pointerBefore);
    const after = await store.listAudit({ namespace: ns });
    expect(after.length).toBe(before + 1);
    expect(after[0]).toMatchObject({ eventType: "blocked" });
  });

  it("a curator force-delete writes an apply audit with the full cascade diff", async () => {
    const g = await readPublished(ns);
    // Pick a node whose children are single-parent so the cascade genuinely
    // removes a subtree. A domaine works: its chapters hang off it alone. (A
    // chapter would NOT — in the faithful graph its lessons also hang off a
    // week, so deleting the chapter leaves them, cascade == 1.)
    const domaine = g.nodes.find((n) => n.type === "domaine" && g.edges.some((e) => e.type === "hasChild" && e.from === n.id))!;
    await apply(deleteNode, { nodeId: domaine.id, force: true });
    const [rec] = await store.listAudit({ namespace: ns, eventType: "apply", limit: 1 });
    expect(rec.mutation).toBe("deleteNode");
    expect(rec.diff!.nodes.removed.some((n) => n.id === domaine.id)).toBe(true);
    expect(rec.diff!.nodes.removed.length).toBeGreaterThan(1); // domaine + its chapters
  });
});

// ── Parity ───────────────────────────────────────────────────────────────────

describe("parity — coverage/force work does not leak into published reads", () => {
  it("published reads are unchanged after a draft-only force cascade", async () => {
    async function reads(): Promise<unknown> {
      const state = newSessionState();
      return runInSession(state, async () => {
        const { activateContext } = await import("../activate.js");
        const r = await activateContext(targetCtx.grade, targetCtx.subject);
        if (!r.ok) throw new Error(r.error);
        const adapter = resolveAdapter(targetCtx.grade, targetCtx.subject)!;
        return { units: adapter.listUnits(), scopes: adapter.scopeValues() };
      });
    }
    const before = await reads();
    const g = await readPublished(ns);
    const chapter = g.nodes.find((n) => n.type === "chapter" && g.edges.some((e) => e.type === "hasChild" && e.from === n.id))!;
    await apply(deleteNode, { nodeId: chapter.id, force: true }); // draft only
    const after = await reads();
    expect(after).toEqual(before);
  });
});
