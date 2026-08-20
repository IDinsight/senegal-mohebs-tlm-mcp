/*
 * walk_graph + namespace_stats — the generic graph reads
 *
 * Two layers:
 *   • walkGraph (pure) — BFS mechanics on a small hand-built graph, where every
 *     depth/filter/pagination assertion is exact: direction, edge/label filters,
 *     depth truncation, cursor paging, includeEdges, unknown-node error.
 *   • walkActiveGraph / namespaceStats (integration) — the tool cores against the
 *     seeded CI-maths store: published vs draft slot, the draft role gate, the
 *     orientation snapshot, and namespace scoping.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { listAvailableContexts, newSessionState, runInSession } from "../../context/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import { walkGraph } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace, mintNodeId,
  runGraphMutation, __resetMutationsForTest, __resetDraftTokensForTest,
} from "../../kg-store/index.js";
import { addNode, addNodes, createEdges } from "../../kg-recipes/index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import { activateContext } from "../../activate.js";
import { walkActiveGraph, walkDocument, namespaceStats, exportGraphView } from "../graph.js";
import type { KgNodeStore, StoredMeta, MutationGraph } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile, CurriculumModel, RawGraphSnapshot } from "../../types.js";

// ── Pure BFS on a hand-built graph ────────────────────────────────────────────
// A tiny content tree: root(Course) → a,b (LessonGrouping) → a1,a2,b1 (Lesson),
// plus one alignment edge a1 → sfi so edge-type filtering has something to skip.
const SAMPLE: RawGraphSnapshot = {
  nodes: [
    { id: "root", labels: ["Course"], properties: {} },
    { id: "a", labels: ["LessonGrouping"], properties: {} },
    { id: "b", labels: ["LessonGrouping"], properties: {} },
    { id: "a1", labels: ["Lesson"], properties: {} },
    { id: "a2", labels: ["Lesson"], properties: {} },
    { id: "b1", labels: ["Lesson"], properties: {} },
    { id: "sfi", labels: ["StandardsFrameworkItem"], properties: {} },
  ],
  relationships: [
    { id: "hasPart:root->a", type: "hasPart", start: "root", end: "a", properties: {} },
    { id: "hasPart:root->b", type: "hasPart", start: "root", end: "b", properties: {} },
    { id: "hasPart:a->a1", type: "hasPart", start: "a", end: "a1", properties: {} },
    { id: "hasPart:a->a2", type: "hasPart", start: "a", end: "a2", properties: {} },
    { id: "hasPart:b->b1", type: "hasPart", start: "b", end: "b1", properties: {} },
    { id: "hasEducationalAlignment:a1->sfi", type: "hasEducationalAlignment", start: "a1", end: "sfi", properties: {} },
  ],
} as unknown as RawGraphSnapshot;

const sampleModel = { rawGraph: SAMPLE } as unknown as CurriculumModel;
const idsOf = (result: { nodes: Array<{ id: string }> }) => result.nodes.map((node) => node.id).sort();

describe("walkGraph (pure BFS)", () => {
  it("walks OUT over hasPart and skips edges not in edgeTypes", () => {
    const result = walkGraph(sampleModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"], maxDepth: 3 });
    if ("error" in result) throw new Error(result.error);
    // sfi is reachable only by the alignment edge, which we did not follow.
    expect(idsOf(result)).toEqual(["a", "a1", "a2", "b", "b1", "root"]);
    expect(result.truncated).toBe(false);
    expect(result.edges!.length).toBe(5); // the five hasPart edges
  });

  it("emits only nodeTypes but still traverses THROUGH non-matching nodes", () => {
    const result = walkGraph(sampleModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"], nodeTypes: ["Lesson"] });
    if ("error" in result) throw new Error(result.error);
    // Groupings a,b are walked through but not emitted; only the three Lessons are.
    expect(idsOf(result)).toEqual(["a1", "a2", "b1"]);
  });

  it("walks IN from a leaf up to its ancestors", () => {
    const result = walkGraph(sampleModel, { fromId: "a1", direction: "in", edgeTypes: ["hasPart"] });
    if ("error" in result) throw new Error(result.error);
    expect(idsOf(result)).toEqual(["a", "a1", "root"]);
  });

  it("walks BOTH directions one hop from a middle node (up to its parent, down to its children)", () => {
    const result = walkGraph(sampleModel, { fromId: "a", direction: "both", edgeTypes: ["hasPart"], maxDepth: 1 });
    if ("error" in result) throw new Error(result.error);
    expect(idsOf(result)).toEqual(["a", "a1", "a2", "root"]);
  });

  it("reports truncated when maxDepth cuts the walk", () => {
    const result = walkGraph(sampleModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"], maxDepth: 1 });
    if ("error" in result) throw new Error(result.error);
    expect(idsOf(result)).toEqual(["a", "b", "root"]);
    expect(result.truncated).toBe(true);
  });

  it("pages through the whole walk with a cursor, no overlap or gaps", () => {
    const collected: string[] = [];
    let cursor: string | undefined;
    // Small limit forces multiple pages over the 6-node walk.
    for (let page = 0; page < 10; page++) {
      const result = walkGraph(sampleModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"], limit: 2, cursor });
      if ("error" in result) throw new Error(result.error);
      collected.push(...result.nodes.map((node) => node.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    // Every node exactly once.
    expect(collected.sort()).toEqual(["a", "a1", "a2", "b", "b1", "root"]);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("rejects a malformed cursor", () => {
    const result = walkGraph(sampleModel, { fromId: "root", direction: "out", cursor: "!!!not-base64!!!" });
    expect("error" in result && result.error).toMatch(/Invalid cursor/);
  });

  it("omits edges when includeEdges is false", () => {
    const result = walkGraph(sampleModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"], includeEdges: false });
    if ("error" in result) throw new Error(result.error);
    expect(result.edges).toBeUndefined();
  });

  it("returns an error for an unknown fromId", () => {
    const result = walkGraph(sampleModel, { fromId: "nope", direction: "out" });
    expect("error" in result && result.error).toMatch(/not found/);
  });
});

// A wide star: one root with 60 children, to exercise the default page size.
const WIDE: RawGraphSnapshot = {
  nodes: [
    { id: "root", labels: ["Course"], properties: {} },
    ...Array.from({ length: 60 }, (_unused, index) => ({ id: `c${index}`, labels: ["Lesson"], properties: {} })),
  ],
  relationships: Array.from({ length: 60 }, (_unused, index) => ({
    id: `hasPart:root->c${index}`, type: "hasPart", start: "root", end: `c${index}`, properties: {},
  })),
} as unknown as RawGraphSnapshot;
const wideModel = { rawGraph: WIDE } as unknown as CurriculumModel;

describe("walkGraph pagination + overflow flags", () => {
  it("defaults to a 50-node page and flags truncatedByLimit (not depth truncated)", () => {
    const result = walkGraph(wideModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"] });
    if ("error" in result) throw new Error(result.error);
    expect(result.nodes.length).toBe(50);        // default limit, not all 61
    expect(result.truncatedByLimit).toBe(true);  // more remain on the next page
    expect(result.truncated).toBe(false);        // depth cap did NOT cut it
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns everything and clears the flags when the limit covers the walk", () => {
    const result = walkGraph(wideModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"], limit: 500 });
    if ("error" in result) throw new Error(result.error);
    expect(result.nodes.length).toBe(61);        // root + 60 children
    expect(result.truncatedByLimit).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("keeps truncatedByLimit (page) distinct from truncated (depth)", () => {
    // Small graph, maxDepth 1: the depth cap cuts it, but the page limit does not.
    const result = walkGraph(sampleModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"], maxDepth: 1 });
    if ("error" in result) throw new Error(result.error);
    expect(result.truncated).toBe(true);
    expect(result.truncatedByLimit).toBe(false);
    expect(result.truncatedBySize).toBe(false); // small nodes never hit the byte budget
  });

  // Fat nodes: a big `content` blob makes each node ~1 KB serialized, so a modest
  // node COUNT still overflows — the byte trim, not `limit`, must cut the page.
  const fatStar = (count: number, fill: string): CurriculumModel => ({
    rawGraph: {
      nodes: [
        { id: "root", labels: ["Course"], properties: {} },
        ...Array.from({ length: count }, (_unused, index) => ({ id: `f${index}`, labels: ["Lesson"], properties: { content: fill } })),
      ],
      relationships: Array.from({ length: count }, (_unused, index) => ({
        id: `hasPart:root->f${index}`, type: "hasPart", start: "root", end: `f${index}`, properties: {},
      })),
    },
  } as unknown as CurriculumModel);

  it("trims a page to the byte budget and tells the caller how to shrink it", () => {
    const fatModel = fatStar(20, "x".repeat(1000));
    process.env.TLM_WALK_MAX_PAGE_BYTES = "3000"; // ~3 KB: only a few fat nodes fit
    try {
      const result = walkGraph(fatModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"], limit: 50, includeEdges: false });
      if ("error" in result) throw new Error(result.error);
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.length).toBeLessThan(21);   // budget cut below the 21 available
      expect(result.truncatedBySize).toBe(true);
      expect(result.truncatedByLimit).toBe(true);     // more remain → paginate
      expect(result.hint).toMatch(/byte budget/i);
      expect(result.nextCursor).not.toBeNull();
    } finally {
      delete process.env.TLM_WALK_MAX_PAGE_BYTES;
    }
  });

  it("still pages through every node when the byte budget trims each page", () => {
    const fatModel = fatStar(12, "y".repeat(1000));
    process.env.TLM_WALK_MAX_PAGE_BYTES = "3000";
    try {
      const collected: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const result = walkGraph(fatModel, { fromId: "root", direction: "out", edgeTypes: ["hasPart"], limit: 50, includeEdges: false, cursor });
        if ("error" in result) throw new Error(result.error);
        collected.push(...result.nodes.map((node) => node.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      const expected = ["root", ...Array.from({ length: 12 }, (_unused, index) => `f${index}`)].sort();
      expect(collected.sort()).toEqual(expected); // every node, exactly once — no gap, no dup
      expect(new Set(collected).size).toBe(collected.length);
    } finally {
      delete process.env.TLM_WALK_MAX_PAGE_BYTES;
    }
  });
});

// ── Integration: the tool cores against the seeded store ──────────────────────
const emptyHistory: HistoryFile = { version: 3, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [], getObjectMd5: async () => null, downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory, writeHistory: async () => {},
};
const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };
const SIGNED_IN_NO_ROLE: Actor = { id: "guest-uid", email: "guest@test", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const ns = kgNamespace(targetCtx.grade, targetCtx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const adapter = resolveAdapter(workspace, grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await freshStore.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await freshStore.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return freshStore;
}

async function withActiveContext<T>(actor: Actor | null, fn: () => Promise<T>): Promise<T> {
  const state = newSessionState();
  return runInSession(state, async () => {
    if (actor) __setActorForTest(actor);
    else __setActorForTest(null);
    const activation = await activateContext(targetCtx.workspace, targetCtx.grade, targetCtx.subject);
    if (!activation.ok) throw new Error(`activate: ${activation.error}`);
    return fn();
  });
}


// Stage a real draft edit (a new Lesson under the first chapter) so draft-slot
// reads have something to reflect. Returns the new node's id.
async function stageALessonEdit(): Promise<string> {
  const [nodes] = await Promise.all([store.listNodes(ns, "a")]);
  const chapter = nodes.find((node) => (node.labels ?? []).includes("LessonGrouping") && (node.properties?.raw as Record<string, unknown> | undefined)?.groupName === "Chapitre")!;
  const newNodeId = mintNodeId();
  const args = { namespace: ns, parentId: chapter.id, label: "Lesson", newNodeId, title: "Draft-only lesson" };
  const preview = await runGraphMutation({ namespace: ns, mutation: addNode, args });
  if (preview.phase !== "preview") throw new Error("expected preview");
  await runGraphMutation({ namespace: ns, mutation: addNode, args, confirm: true, token: preview.confirmationToken });
  return newNodeId;
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

describe("namespace_stats", () => {
  it("reports counts, roots, and a closed draft on a fresh seed", async () => {
    const stats = await withActiveContext(CURATOR, namespaceStats);
    expect(stats.namespace).toBe(ns);
    // Reads come from the seed's published slot "a".
    expect(stats.physicalSlot).toBe("a");

    const nodeCounts = stats.nodeCounts as Record<string, number>;
    expect(nodeCounts.Lesson).toBeGreaterThan(0);
    expect(nodeCounts.StandardsFrameworkItem).toBeGreaterThan(0);

    const edgeCounts = stats.edgeCounts as Record<string, number>;
    expect(edgeCounts.hasPart).toBeGreaterThan(0);

    // CI maths has Course roots (the two content roots).
    const roots = stats.roots as Array<{ labels: string[] }>;
    expect(roots.some((root) => root.labels.includes("Course"))).toBe(true);

    expect(stats.draft).toEqual({ open: false });
    expect(stats.coverageFlags as string[]).toContain("no draft open");
  });

  it("reflects an open draft and its staged-edit count", async () => {
    const stats = await withActiveContext(CURATOR, async () => {
      await stageALessonEdit();
      return namespaceStats();
    });
    const draft = stats.draft as { open: boolean; editsStaged?: number };
    expect(draft.open).toBe(true);
    expect(draft.editsStaged!).toBeGreaterThan(0);
    expect(stats.coverageFlags as string[]).not.toContain("no draft open");
  });
});

describe("walk_graph (tool core)", () => {
  it("walks a course subtree from the published slot", async () => {
    const result = await withActiveContext(CURATOR, async () => {
      const nodes = await store.listNodes(ns, "a");
      const courseId = nodes.find((node) => (node.labels ?? []).includes("Course"))!.id;
      return walkActiveGraph({ fromId: courseId, direction: "out", edgeTypes: ["hasPart", "hasChild"], maxDepth: 10 });
    });
    expect(result.slot).toBe("published");
    expect(result.physicalSlot).toBe("a"); // published resolves to the seed slot "a"
    expect((result.nodes as unknown[]).length).toBeGreaterThan(0);
  });

  it("returns a no-draft notice for slot:draft when no draft is open", async () => {
    const result = await withActiveContext(CURATOR, async () => {
      const nodes = await store.listNodes(ns, "a");
      const courseId = nodes.find((node) => (node.labels ?? []).includes("Course"))!.id;
      return walkActiveGraph({ fromId: courseId, direction: "out", slot: "draft" });
    });
    expect(result.noDraft).toBe(true);
  });

  it("sees a staged edit when walking slot:draft", async () => {
    const result = await withActiveContext(CURATOR, async () => {
      const stagedId = await stageALessonEdit();
      const nodes = await store.listNodes(ns, "a");
      const chapter = nodes.find((node) => (node.labels ?? []).includes("LessonGrouping") && (node.properties?.raw as Record<string, unknown> | undefined)?.groupName === "Chapitre")!;
      const walked = await walkActiveGraph({ fromId: chapter.id, direction: "out", edgeTypes: ["hasPart"], maxDepth: 2, slot: "draft" });
      return { walked, stagedId };
    });
    const walkedNodeIds = (result.walked.nodes as Array<{ id: string }>).map((node) => node.id);
    expect(walkedNodeIds).toContain(result.stagedId);
    // The draft lives on slot "b" (published is still "a"), so the walk reports it.
    expect(result.walked.physicalSlot).toBe("b");
  });

  it("denies slot:draft to an actor without the draft-read role", async () => {
    const result = await withActiveContext(SIGNED_IN_NO_ROLE, async () => {
      const nodes = await store.listNodes(ns, "a");
      const courseId = nodes.find((node) => (node.labels ?? []).includes("Course"))!.id;
      return walkActiveGraph({ fromId: courseId, direction: "out", slot: "draft" });
    });
    expect(result.phase).toBe("unauthorized");
  });
});

// Stage a minimal document in the draft: a root TeachingLearningMaterial (with an
// assembly guide) that `covers` an existing seeded Course — the simple no-section
// case. Returns the TLM + Course ids. Proves the whole chain the reader depends on
// (add_nodes doc layer → store raw.* → toRawEnvelope → documentSubgraph).
async function stageADocument(): Promise<{ tlmId: string; courseId: string }> {
  const nodes = await store.listNodes(ns, "a");
  const courseId = nodes.find((node) => (node.labels ?? []).includes("Course"))!.id;
  const tlmId = mintNodeId();

  const addArgs = {
    namespace: ns,
    items: [{
      label: "TeachingLearningMaterial", newNodeId: tlmId, title: "Guide de l'enseignant",
      properties: { metadata: { assemblyGuide: "Une leçon par page." } },
    }],
  };
  const addPreview = await runGraphMutation({ namespace: ns, mutation: addNodes, args: addArgs });
  if (addPreview.phase !== "preview") throw new Error("expected add preview");
  await runGraphMutation({ namespace: ns, mutation: addNodes, args: addArgs, confirm: true, token: addPreview.confirmationToken });

  const edgeArgs = { namespace: ns, edges: [{ edgeType: "covers", fromId: tlmId, toId: courseId }] };
  const edgePreview = await runGraphMutation({ namespace: ns, mutation: createEdges, args: edgeArgs });
  if (edgePreview.phase !== "preview") throw new Error("expected edge preview");
  await runGraphMutation({ namespace: ns, mutation: createEdges, args: edgeArgs, confirm: true, token: edgePreview.confirmationToken });

  return { tlmId, courseId };
}

describe("walk_document (tool core)", () => {
  it("resolves a staged TLM: its assembly guide + the Course it covers (fallback scope)", async () => {
    const result = await withActiveContext(CURATOR, async () => {
      const { tlmId, courseId } = await stageADocument();
      return { doc: await walkDocument({ tlmId, slot: "draft" }), courseId };
    });
    expect(result.doc.scope).toBe("course");                 // no section spine → Course fallback
    expect(result.doc.assemblyGuide).toBe("Une leçon par page.");
    expect(result.doc.physicalSlot).toBe("b");               // the draft lives on slot "b"
    const curriculumIds = (result.doc.curriculum as { nodes: Array<{ id: string }> }).nodes.map((node) => node.id);
    expect(curriculumIds).toContain(result.courseId);        // the covered Course subtree is resolved
  });

  it("errors clearly for an id that is not a TeachingLearningMaterial", async () => {
    const result = await withActiveContext(CURATOR, async () => {
      const nodes = await store.listNodes(ns, "a");
      const lessonId = nodes.find((node) => (node.labels ?? []).includes("Lesson"))!.id;
      return walkDocument({ tlmId: lessonId });
    });
    expect(result.error as string).toMatch(/not found/);
  });

  it("denies slot:draft to an actor without the draft-read role", async () => {
    const result = await withActiveContext(SIGNED_IN_NO_ROLE, async () => walkDocument({ tlmId: "anything", slot: "draft" }));
    expect(result.phase).toBe("unauthorized");
  });
});

describe("export_graph_view (tool core)", () => {
  const courseId = async (): Promise<string> => {
    const nodes = await store.listNodes(ns, "a");
    return nodes.find((node) => (node.labels ?? []).includes("Course"))!.id;
  };

  // The fixture Course subtree is large, so the happy-path assertions run under a
  // generous byte budget; the size-guard behaviour is asserted separately below
  // with a deliberately tiny budget.
  beforeEach(() => { process.env.TLM_SUBTREE_MAX_BYTES = String(5 * 1024 * 1024); });
  afterAll(() => { delete process.env.TLM_SUBTREE_MAX_BYTES; });

  it("returns a scoped DisplayGraph rooted at fromId", async () => {
    const { result, rootId } = await withActiveContext(CURATOR, async () => {
      const rootId = await courseId();
      return { result: await exportGraphView({ fromId: rootId, maxDepth: 3 }), rootId };
    });
    // The explorer's DisplayGraph shape: nodes/edges plus a meta envelope with a
    // legend taxonomy and the derived view tabs — the same read the /kg route serves.
    const nodes = result.nodes as Array<{ id: string; cat: string }>;
    const meta = result.meta as { taxonomy: unknown[]; viewConfig: { views: unknown[] }; counts: { nodes: number } };
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.some((node) => node.id === rootId)).toBe(true);
    expect(meta.taxonomy.length).toBeGreaterThan(0);
    expect(meta.viewConfig.views.length).toBeGreaterThan(0);
    expect(meta.counts.nodes).toBe(nodes.length);
  });

  it("bounds the scope: a shallow depth returns fewer nodes than a deep one", async () => {
    const { shallow, deep } = await withActiveContext(CURATOR, async () => {
      const id = await courseId();
      return {
        shallow: await exportGraphView({ fromId: id, maxDepth: 1 }),
        deep: await exportGraphView({ fromId: id, maxDepth: 6 }),
      };
    });
    expect((shallow.nodes as unknown[]).length).toBeLessThan((deep.nodes as unknown[]).length);
  });

  it("drops the raw props bag by default and includes it when detail:true", async () => {
    const { lean, full } = await withActiveContext(CURATOR, async () => {
      const id = await courseId();
      return {
        lean: await exportGraphView({ fromId: id, maxDepth: 2 }),
        full: await exportGraphView({ fromId: id, maxDepth: 2, detail: true }),
      };
    });
    const propsKeys = (r: Record<string, unknown>) =>
      (r.nodes as Array<{ props: Record<string, unknown> }>).reduce((sum, node) => sum + Object.keys(node.props).length, 0);
    expect(propsKeys(lean)).toBe(0);
    expect(propsKeys(full)).toBeGreaterThan(0);
  });

  it("refuses an oversized slice with a sized, actionable message", async () => {
    const result = await withActiveContext(CURATOR, async () => {
      process.env.TLM_SUBTREE_MAX_BYTES = "2048"; // ~2 KB: a whole-Course subtree cannot fit
      return exportGraphView({ fromId: await courseId(), maxDepth: 8 });
    });
    expect(result.tooLarge).toBe(true);
    expect(result.message as string).toMatch(/budget/i);
    expect((result.counts as { nodes: number }).nodes).toBeGreaterThan(0);
  });

  it("errors clearly for an unknown fromId", async () => {
    const result = await withActiveContext(CURATOR, async () => exportGraphView({ fromId: "does-not-exist" }));
    expect(result.error as string).toMatch(/not found/);
  });
});
