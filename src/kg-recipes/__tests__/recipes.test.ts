// ── kg-recipes — the generic verbs, end to end on the CI-maths seed ──────────
// Replaces the old per-recipe (add_lesson/…/renumber) + lc-fidelity suites. The
// verbs carry NO subject vocabulary: add_node takes an LC label and DERIVES the
// created node's identity skeleton from the graph (an existing Lesson/chapter),
// so a created node round-trips through the parser exactly like a seeded one.
//
// Covered: add_node (create a Lesson under a chapter, aligned to an expectation;
// create a LessonGrouping), move_node (rehome along the hasPart axis, week axis
// untouched), reposition (single-node ordinal edit), set_content — each two-phase
// (dry-run = diff + token, no state change; confirm = atomic draft apply), and a
// faithful re-parse of the draft.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { CONFIG } from "../../config.js";
import { listAvailableContexts, subjectDir } from "../../context/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel, toRawEnvelope } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, mintNodeId, edgeId as makeEdgeId,
  __resetMutationsForTest, __resetDraftTokensForTest,
} from "../../kg-store/index.js";
import { addNode, moveNode, reposition, setContent } from "../index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import type { MutationGraph, GraphMutation, StoredMeta, KgNodeStore } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile, CurriculumModel } from "../../types.js";

const HAS_PART = "hasPart";
const ALIGN = "hasEducationalAlignment";

const emptyHistory: HistoryFile = { version: 2, entries: [] };
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
const ns = kgNamespace("ci", "maths");
const adapter = () => resolveAdapter("ci", "maths")!;
const coverage = (graph: MutationGraph): string[] => adapter().coverageWarnings?.(graph as never) ?? [];

async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile), "utf8"));
    const subjectAdapter = resolveAdapter(grade, subject);
    if (!subjectAdapter) continue;
    const { nodes, edges } = serializeModel(subjectAdapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: subjectAdapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await freshStore.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await freshStore.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return freshStore;
}

const strip = <T extends { slot?: unknown }>(record: T) => {
  const { slot: _slot, ...rest } = record;
  return rest;
};
async function readSlot(slot: "a" | "b"): Promise<MutationGraph> {
  const [nodes, edges] = await Promise.all([store.listNodes(ns, slot), store.listEdges(ns, slot)]);
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}
async function readPublished(): Promise<MutationGraph> {
  const pointer = await store.readPointer(ns);
  return readSlot(pointer!.publishedSlot);
}
async function readDraft(): Promise<MutationGraph | null> {
  const pointer = await store.readPointer(ns);
  return pointer?.draftSlot ? readSlot(pointer.draftSlot) : null;
}
const modelOf = (graph: MutationGraph): CurriculumModel => adapter().parse(toRawEnvelope({ nodes: graph.nodes, edges: graph.edges }));

async function runRecipe<A>(mutation: GraphMutation<A>, args: A) {
  const preview = await runGraphMutation({ namespace: ns, mutation, args, coverage });
  if (preview.phase !== "preview") return { preview, confirm: null };
  const confirm = await runGraphMutation({ namespace: ns, mutation, args, confirm: true, token: preview.confirmationToken, coverage });
  return { preview, confirm };
}

// A chapter + some lesson + some expectation, from the published seed. Post
// two-Course split, lessons live under weeks (schedule axis), not chapters, so
// take the lesson from a week rather than the chapter.
function pick(graph: MutationGraph) {
  const model = modelOf(graph);
  const chapter = model.unitsOfKind("chapter").sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  const week = model.unitsOfKind("week").find((candidate) => model.childrenOf(candidate.id).some((child) => child.kind === "lesson"))!;
  const lesson = model.childrenOf(week.id).find((child) => child.kind === "lesson")!;
  const expectation = model.unitsOfKind("expectation")[0];
  return { chapterId: chapter.id, lessonId: lesson.id, expectationId: expectation.id };
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

describe("add_node", () => {
  it("creates a Lesson under a chapter, aligned to an expectation; identity copied from an existing lesson", async () => {
    const published = await readPublished();
    const { chapterId, expectationId } = pick(published);
    const lessonId = mintNodeId();
    const args = { namespace: ns, parentId: chapterId, label: "Lesson", newNodeId: lessonId, title: "Nouvelle leçon", alignTo: expectationId };

    const preview = await runGraphMutation({ namespace: ns, mutation: addNode, args, coverage });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.diff.nodes.added.map((node) => node.id)).toEqual([lessonId]);
    const added = preview.diff.edges.added.map((edge) => edge.id);
    expect(added).toContain(makeEdgeId(HAS_PART, chapterId, lessonId));   // containment
    expect(added).toContain(makeEdgeId(ALIGN, lessonId, expectationId));  // alignment
    expect(await readDraft()).toBeNull(); // dry-run stages nothing

    const confirm = await runGraphMutation({ namespace: ns, mutation: addNode, args, confirm: true, token: preview.confirmationToken, coverage });
    expect(confirm.phase).toBe("apply");

    const draft = (await readDraft())!;
    const node = draft.nodes.find((candidate) => candidate.id === lessonId)!;
    expect(node.type).toBe("lesson");
    expect(node.labels).toContain("Lesson");
    const raw = node.properties.raw as Record<string, any>;
    expect(raw.normalizedType).toBe("Lesson");
    expect(raw.metadata.order).toBe(node.properties.order); // maths' ordinal path, mirrored to normalized order
    // Faithful re-parse: the new lesson shows up under its chapter, aligned.
    const model = modelOf(draft);
    expect(model.childrenOf(chapterId).some((child) => child.id === lessonId && child.kind === "lesson")).toBe(true);
  });

  it("creates a LessonGrouping (chapter) that re-parses as a chapter", async () => {
    const published = await readPublished();
    // Attach under the Course content root — the canonical parent the chapters
    // now hang under (Course --hasPart--> LessonGrouping). The Course is a
    // non-spine node, so it isn't in the parsed model; find it by LC label.
    const root = published.nodes.find((node) => (node.labels ?? []).includes("Course"))!.id;
    const groupingId = mintNodeId();
    const { confirm } = await runRecipe(addNode, { namespace: ns, parentId: root, label: "LessonGrouping", newNodeId: groupingId, title: "Chapitre neuf", properties: { groupName: "Chapitre" } });
    expect(confirm?.phase).toBe("apply");

    const node = (await readDraft())!.nodes.find((candidate) => candidate.id === groupingId)!;
    expect(node.labels).toContain("LessonGrouping");
    // Grouping-ness is label-driven now — no borrowed SFI `normalizedStatementType`.
    expect((node.properties.raw as any).normalizedStatementType).toBeUndefined();
    expect((node.properties.raw as any).groupName).toBe("Chapitre");
    expect(node.properties.title).toBe("Chapitre neuf"); // parsed as a grouping ⇒ name in `title`
  });

  it("blocks a nonexistent parent and a non-SFI alignTo", async () => {
    const { chapterId } = pick(await readPublished());
    const bad = await runGraphMutation({ namespace: ns, mutation: addNode, args: { namespace: ns, parentId: "nope", label: "Lesson", newNodeId: mintNodeId() }, coverage });
    expect(bad.phase).toBe("blocked");
    const badAlign = await runGraphMutation({ namespace: ns, mutation: addNode, args: { namespace: ns, parentId: chapterId, label: "Lesson", newNodeId: mintNodeId(), alignTo: chapterId }, coverage });
    expect(badAlign.phase).toBe("blocked");
    if (badAlign.phase === "blocked") expect(badAlign.errors.join()).toMatch(/StandardsFrameworkItem|standard/i);
  });
});

describe("typed-add core behaviors (boilerplate, supports direction, root node)", () => {
  it("copies LC boilerplate from a sibling and stamps raw.identifier", async () => {
    const published = await readPublished();
    const { chapterId } = pick(published);
    const lessonId = mintNodeId();
    const { confirm } = await runRecipe(addNode, { namespace: ns, parentId: chapterId, label: "Lesson", newNodeId: lessonId, title: "Leçon" });
    expect(confirm?.phase).toBe("apply");
    const raw = (await readDraft())!.nodes.find((node) => node.id === lessonId)!.properties.raw as Record<string, any>;
    // Boilerplate a seeded maths Lesson carries, copied onto the created one.
    expect(raw.license).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(raw.provider).toBe("Learning Commons ontology (generated)");
    expect(raw.academicSubject).toBe("Mathematics");
    expect(raw.attributionStatement).toBeTruthy();
    expect(raw.identifier).toBe(lessonId);
  });

  it("attaches a LearningComponent to its SFI via `supports` (child→parent direction)", async () => {
    const published = await readPublished();
    const sfi = published.nodes.find((node) => (node.labels ?? []).includes("StandardsFrameworkItem"))!.id;
    const compId = mintNodeId();
    const { confirm } = await runRecipe(addNode, { namespace: ns, parentId: sfi, label: "LearningComponent", newNodeId: compId, title: "Sait compter" });
    expect(confirm?.phase).toBe("apply");
    const draft = (await readDraft())!;
    // supports points component → SFI (new node is the source), not parent → child.
    expect(draft.edges.some((edge) => edge.id === makeEdgeId("supports", compId, sfi))).toBe(true);
    expect(draft.edges.some((edge) => edge.id === makeEdgeId("supports", sfi, compId))).toBe(false);
  });

  it("creates a root Course with NO parentId and NO containment edge", async () => {
    const courseId = mintNodeId();
    const { confirm } = await runRecipe(addNode, { namespace: ns, label: "Course", newNodeId: courseId, title: "Cahier d'activités" });
    expect(confirm?.phase).toBe("apply");
    const draft = (await readDraft())!;
    expect(draft.nodes.some((node) => node.id === courseId && (node.labels ?? []).includes("Course"))).toBe(true);
    // No incoming containment edge — it is a root.
    expect(draft.edges.some((edge) => edge.to === courseId && (edge.type === "hasPart" || edge.type === "hasChild"))).toBe(false);
  });
});

describe("move_node + reposition + set_content", () => {
  it("move_node rehomes an activity along hasPart, leaving its alignment (hasEducationalAlignment) axis intact", async () => {
    // Canonical nesting: chapter ▸ Lesson ▸ Activity. Move an activity between two
    // chapters' Student's-Book lessons; its alignment edge (Activity→expectation)
    // must survive.
    const published = await readPublished();
    const model = modelOf(published);
    const lessons = model.unitsOfKind("lesson").filter((lesson) => model.childrenOf(lesson.id).some((child) => child.kind === "task"));
    const fromLesson = lessons[0];
    const toLesson = lessons[1];
    const activity = model.childrenOf(fromLesson.id).find((child) => child.kind === "task")!;
    const alignEdges = published.edges.filter((edge) => edge.type === "hasEducationalAlignment" && edge.from === activity.id).map((edge) => edge.id);
    expect(alignEdges.length).toBeGreaterThan(0);

    const { confirm } = await runRecipe(moveNode, { namespace: ns, nodeId: activity.id, toParentId: toLesson.id });
    expect(confirm?.phase).toBe("apply");
    const draft = (await readDraft())!;
    expect(draft.edges.some((edge) => edge.id === makeEdgeId(HAS_PART, toLesson.id, activity.id))).toBe(true);
    expect(draft.edges.some((edge) => edge.id === makeEdgeId(HAS_PART, fromLesson.id, activity.id))).toBe(false);
    for (const id of alignEdges) expect(draft.edges.some((edge) => edge.id === id)).toBe(true); // alignment axis untouched
  });

  it("reposition sets one node's ordinal without touching anything else", async () => {
    const { chapterId } = pick(await readPublished());
    const { confirm } = await runRecipe(reposition, { namespace: ns, nodeId: chapterId, position: 99 });
    expect(confirm?.phase).toBe("apply");
    const node = (await readDraft())!.nodes.find((candidate) => candidate.id === chapterId)!;
    expect(node.properties.order).toBe(99);
    expect((node.properties.raw as any).metadata.order).toBe(99); // maths mirror path
  });

  it("set_content writes raw.content on any node", async () => {
    const { lessonId } = pick(await readPublished());
    const { confirm } = await runRecipe(setContent, { namespace: ns, nodeId: lessonId, content: "scripted body" });
    expect(confirm?.phase).toBe("apply");
    const node = (await readDraft())!.nodes.find((candidate) => candidate.id === lessonId)!;
    expect((node.properties.raw as any).content).toBe("scripted body");
  });
});
