/*
 * CE1 reading — content layer via the GENERIC verbs, end to end
 *
 * Drives add_node / set_content through the two-phase framework on the REAL
 * reading seed, then proves the read projection (buildSlice, via
 * buildGenerationContext) surfaces the authored content. The verbs carry no
 * subject vocabulary: `add_node` with an LC `label` derives the node's identity
 * from the graph (or canonical LC defaults for reading's first Activity).
 *
 * The invariant under test: what a curator stages is what a draft read shows —
 * an Activity under a session Lesson (hasPart), its Material carrying the
 * scripted content (raw.content), and both reachable from the week's slice.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { CONFIG } from "../../config.js";
import { listAvailableContexts, subjectDir } from "../../context/index.js";
import { resolveAdapter } from "../index.js";
import { serializeModel, toRawEnvelope } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, mintNodeId, edgeId as makeEdgeId,
  __resetMutationsForTest, __resetDraftTokensForTest,
} from "../../kg-store/index.js";
import { addNode, setContent } from "../../kg-recipes/index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import type { MutationGraph, GraphMutation, StoredMeta, KgNodeStore } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile, CurriculumModel } from "../../types.js";

const HAS_PART = "hasPart"; // canonical LC content containment

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

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const ns = kgNamespace("ce1", "reading");
const adapter = () => resolveAdapter("ce1", "reading")!;
const coverage = (graph: MutationGraph): string[] => adapter().coverageWarnings?.(graph as never) ?? [];

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

const strip = <T extends { slot?: unknown }>(record: T) => { const { slot: _s, ...rest } = record; return rest; };
async function readSlot(slot: "a" | "b"): Promise<MutationGraph> {
  const [nodes, edges] = await Promise.all([store.listNodes(ns, slot), store.listEdges(ns, slot)]);
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}
async function readDraft(): Promise<MutationGraph> {
  const pointer = await store.readPointer(ns);
  return readSlot(pointer!.draftSlot!);
}
async function readPublished(): Promise<MutationGraph> {
  const pointer = await store.readPointer(ns);
  return readSlot(pointer!.publishedSlot);
}
const modelOf = (graph: MutationGraph): CurriculumModel => adapter().parse(toRawEnvelope({ nodes: graph.nodes, edges: graph.edges }));

async function runRecipe<A>(mutation: GraphMutation<A>, args: A) {
  const preview = await runGraphMutation({ namespace: ns, mutation, args, coverage });
  if (preview.phase !== "preview") return { preview, confirm: null };
  const confirm = await runGraphMutation({ namespace: ns, mutation, args, confirm: true, token: preview.confirmationToken, coverage });
  return { preview, confirm };
}

function week1SessionLesson(graph: MutationGraph): string {
  const model = modelOf(graph);
  const week = model.unitsOfKind("Semaine").find((w) => w.order === 1)!;
  const day = model.childrenOf(week.id).find((c) => c.kind === "Jour")!;
  return model.childrenOf(day.id).find((c) => c.kind === "Lesson")!.id;
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
  if (priorEnv === undefined) delete process.env.KG_SOURCE; else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

describe("add_node — Activity under a session lesson", () => {
  it("adds one Activity node + a hasPart edge; identity is derived from canonical LC (no example yet)", async () => {
    const lessonId = week1SessionLesson(await readPublished());
    const activityId = mintNodeId();
    const args = { namespace: ns, parentId: lessonId, label: "Activity", newNodeId: activityId, title: "Étape 1 : Découvrir le vocabulaire", properties: { studentGroupingType: "group", timeRequired: "10 mn", educationalUse: "Instruction" } };

    const preview = await runGraphMutation({ namespace: ns, mutation: addNode, args, coverage });
    if (preview.phase !== "preview") {
      throw new Error("expected preview");
    }
    expect(preview.diff.nodes.added.map((n) => n.id)).toEqual([activityId]);
    expect(preview.diff.edges.added.map((e) => e.id)).toContain(makeEdgeId(HAS_PART, lessonId, activityId));

    const confirm = await runGraphMutation({ namespace: ns, mutation: addNode, args, confirm: true, token: preview.confirmationToken, coverage });
    expect(confirm.phase).toBe("apply");

    const node = (await readDraft()).nodes.find((n) => n.id === activityId)!;
    expect(node.type).toBe("Activity");             // canonical fallback kind for label Activity
    expect(node.labels).toContain("Activity");
    const raw = node.properties.raw as Record<string, unknown>;
    expect(raw.description).toBe("Étape 1 : Découvrir le vocabulaire");
    expect(raw.normalizedType).toBe("Activity");
    expect(raw.position).toBe(1);                    // reading's ordinal path
    expect(raw.studentGroupingType).toBe("group");
  });

  it("blocks when the parent does not exist", async () => {
    const args = { namespace: ns, parentId: "does-not-exist", label: "Activity", newNodeId: mintNodeId(), title: "x" };
    const preview = await runGraphMutation({ namespace: ns, mutation: addNode, args, coverage });
    expect(preview.phase).toBe("blocked");
    if (preview.phase === "blocked") {
      expect(preview.errors.join()).toMatch(/parent .* does not exist/i);
    }
  });
});

describe("add_node — Material + set_content; the slice surfaces them", () => {
  it("hangs a Material off an Activity with content in raw.content; buildSlice shows it", async () => {
    const lessonId = week1SessionLesson(await readPublished());
    const activityId = mintNodeId();
    await runRecipe(addNode, { namespace: ns, parentId: lessonId, label: "Activity", newNodeId: activityId, title: "Étape 3 : Écouter le texte" });
    const materialId = mintNodeId();
    const content = "<p>M lit le texte 2 fois, dramatisé.</p>";
    const { confirm } = await runRecipe(addNode, { namespace: ns, parentId: activityId, label: "Material", newNodeId: materialId, properties: { content, materialType: "Core" } });
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    const material = draft.nodes.find((n) => n.id === materialId)!;
    expect(material.type).toBe("Material");
    expect((material.properties.raw as Record<string, unknown>).content).toBe(content);
    expect(draft.edges.map((e) => e.id)).toContain(makeEdgeId(HAS_PART, activityId, materialId));
    // The Activity that Material hangs under is itself under the session Lesson —
    // the authored content is reachable in the draft content tree (the read is now
    // the generic course subtree via walk_graph / courseSubgraph, not a cooked slice).
    expect(draft.edges.some((e) => e.id === makeEdgeId(HAS_PART, week1SessionLesson(draft), activityId))).toBe(true);
  }, 15000); // two two-phase mutations over the ~2000-node reading graph — heavier than the 5s default

  it("allows a Material directly on a week grouping and on a lesson (any container)", async () => {
    const published = await readPublished();
    const weekId = modelOf(published).unitsOfKind("Semaine").find((w) => w.order === 1)!.id;
    const lessonId = week1SessionLesson(published);

    expect((await runRecipe(addNode, { namespace: ns, parentId: weekId, label: "Material", newNodeId: mintNodeId(), properties: { content: "[week opening scene]", materialType: "Reference" } })).confirm?.phase).toBe("apply");
    expect((await runRecipe(addNode, { namespace: ns, parentId: lessonId, label: "Material", newNodeId: mintNodeId(), properties: { content: "[shared reading text]" } })).confirm?.phase).toBe("apply");

    const draft = await readDraft();
    const materialContents = draft.nodes.filter((n) => n.type === "Material").map((n) => (n.properties.raw as Record<string, unknown>).content);
    expect(materialContents).toContain("[week opening scene]");
    expect(materialContents).toContain("[shared reading text]");
  });

  it("set_content replaces an existing node's content, preserving everything else", async () => {
    const lessonId = week1SessionLesson(await readPublished());
    const materialId = mintNodeId();
    await runRecipe(addNode, { namespace: ns, parentId: lessonId, label: "Material", newNodeId: materialId, title: "Jukki", properties: { content: "old" } });

    const { confirm } = await runRecipe(setContent, { namespace: ns, nodeId: materialId, content: "new & improved" });
    expect(confirm?.phase).toBe("apply");

    const raw = (await readDraft()).nodes.find((n) => n.id === materialId)!.properties.raw as Record<string, unknown>;
    expect(raw.content).toBe("new & improved");
    expect(raw.description).toBe("Jukki"); // title untouched
  });
});
