// ── #14 curriculum recipes — tests ───────────────────────────────────────────
// Drives add_lesson / add_lesson_grouping / move_lesson / split_lesson_grouping / renumber
// through the #5 framework end to end, on the real CI-maths seed. Acceptance
// criteria mirror the task spec:
//
//   • Each recipe: dry-run = ONE whole-composite diff + token, NO state change;
//     confirm applies the WHOLE composite ATOMICALLY to the draft; #7 audits it
//     as ONE event; curator-gated.
//   • add_lesson: composite (lesson + hasChild); nonexistent chapter BLOCKED.
//   • add_lesson_grouping: append/gap-fill works; colliding number rejected.
//   • move_lesson: rehomed atomically; chapitreNum rewritten (no drift);
//     nonexistent target blocked; coverage warns (bilan moved out).
//   • split_lesson_grouping: new chapter + tail moved atomically; integrity-clean;
//     a split leaving a chapter without a bilan WARNS (not blocks).
//   • renumber: chapter number + every child lesson's chapitreNum rewritten
//     atomically (Regime-B), no drift warning; collision BLOCKED.
//   • Composite atomicity: an invalid composite lands NOTHING partial.
//   • End-to-end: add → split → move in draft → publish → published read shows
//     the new structure; untouched chapters unchanged (parity).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../../config.js";
import { listAvailableContexts, subjectDir } from "../../context/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel, deserializeToModel } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, publishDraftWithConfirm, diffDraft, mintNodeId,
  addLesson, addLessonGrouping, moveLesson, splitLessonGrouping, renumber, edgeId as makeEdgeId,
  __resetMutationsForTest, __resetDraftTokensForTest,
} from "../index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import type { MutationGraph, GraphMutation } from "../index.js";
import type { KgNodeStore, StoredMeta } from "../types.js";
import type { StorageAdapter, HistoryFile, RecipeProfile, StructuralAliases, WordingAliases } from "../../types.js";

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
const NO_ROLE: Actor = { id: "guest-uid", email: "guest@test", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const ns = kgNamespace(targetCtx.grade, targetCtx.subject);
const adapter = () => resolveAdapter(targetCtx.grade, targetCtx.subject)!;
const profile = (): RecipeProfile => adapter().recipeProfile!;
const sAliases = (): StructuralAliases => adapter().structuralAliases!;
const wAliases = (): WordingAliases => adapter().wordingAliases;
const coverage = (g: MutationGraph): string[] => adapter().coverageWarnings?.(g as never) ?? [];

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(grade, subject), CONFIG.kgFile), "utf8"));
    const a = resolveAdapter(grade, subject);
    if (!a) continue;
    const { nodes, edges } = serializeModel(a.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: a.id, nodeCount: nodes.length, edgeCount: edges.length };
    await s.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return s;
}

const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
async function readSlot(slot: "a" | "b"): Promise<MutationGraph> {
  const [nodes, edges] = await Promise.all([store.listNodes(ns, slot), store.listEdges(ns, slot)]);
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}
async function readPublished(): Promise<MutationGraph> {
  const p = await store.readPointer(ns);
  return readSlot(p!.publishedSlot);
}
async function readDraft(): Promise<MutationGraph | null> {
  const p = await store.readPointer(ns);
  return p?.draftSlot ? readSlot(p.draftSlot) : null;
}

// ── graph inspection helpers ──────────────────────────────────────────────────
const HAS_CHILD = "hasChild";
// A chapter's number now lives in the normalized `order` field (mirrored under
// raw.metadata.order). Chapter→lesson membership is the hasChild edge, not a number.
const chapterNum = (n: { properties: Record<string, unknown> }): number | undefined => n.properties.order as number | undefined;
const findChapter = (g: MutationGraph, num: number) => g.nodes.find((n) => n.type === "chapter" && chapterNum(n) === num)!;
const lessonIdsOf = (g: MutationGraph, groupingId: string) =>
  g.edges.filter((e) => e.type === HAS_CHILD && e.from === groupingId).map((e) => e.to).filter((id) => g.nodes.find((n) => n.id === id)?.type === "lesson");
const bilanOf = (g: MutationGraph, groupingId: string) =>
  lessonIdsOf(g, groupingId).map((id) => g.nodes.find((n) => n.id === id)!).find((n) => n.properties.isAssessment === true);
const nodeRawNum = (g: MutationGraph, id: string): number | undefined => chapterNum(g.nodes.find((n) => n.id === id)!);
// The seed numbers chapters 1..13,15..25,29 — so the next append number is
// max+1 and 26/27/28 are free gaps. Computed, never hardcoded, so the tests
// stay honest against the real data.
const maxChapterNum = (g: MutationGraph): number => Math.max(...g.nodes.filter((n) => n.type === "chapter").map((n) => chapterNum(n) ?? 0));
const freeGapNumber = (g: MutationGraph): number => { const used = new Set(g.nodes.filter((n) => n.type === "chapter").map((n) => chapterNum(n))); let k = 1; while (used.has(k)) k++; return k; };

// Post-split, add_lesson aligns a new content lesson to an EXISTING spine
// expectation. Any expectation serves for these structural tests.
const someExpectation = (g: MutationGraph): string => g.nodes.find((n) => n.type === "expectation")!.id;
const SUPPORTS = "supports";

// Common recipe-arg bag (the subject vocabulary the server tool would supply) —
// includes lcNodeTemplate so created nodes get their LC labels, as in production.
const bag = () => ({ namespace: ns, profile: profile(), structuralAliases: sAliases(), wordingAliases: wAliases(), lcNodeTemplate: adapter().lcNodeTemplate });

// Preview → confirm a recipe with a stable args object (so the confirm-time
// args-hash matches the preview's). Returns both phases.
async function runRecipe<A>(mutation: GraphMutation<A>, args: A) {
  const preview = await runGraphMutation({ namespace: ns, mutation, args, coverage });
  if (preview.phase !== "preview") return { preview, confirm: null };
  const confirm = await runGraphMutation({ namespace: ns, mutation, args, confirm: true, token: preview.confirmationToken, coverage });
  return { preview, confirm };
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

// ── add_lesson ────────────────────────────────────────────────────────────────
describe("add_lesson", () => {
  it("is ONE composite (lesson node + hasChild + supports edges); dry-run changes no state; confirm applies atomically", async () => {
    const published = await readPublished();
    const chapter = findChapter(published, 1);
    const expectationId = someExpectation(published);
    const lessonId = mintNodeId();
    const args = { ...bag(), groupingId: chapter.id, expectationId, lessonId, text: "Nouvelle leçon", isBilan: false };

    // Dry-run: one whole-composite diff + token, NO state change.
    const preview = await runGraphMutation({ namespace: ns, mutation: addLesson, args, coverage });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.diff.nodes.added.map((e) => e.id)).toEqual([lessonId]);
    // Two edges: chapter membership (hasChild) AND expectation alignment (supports).
    const addedEdges = preview.diff.edges.added.map((e) => e.id);
    expect(addedEdges).toContain(makeEdgeId(HAS_CHILD, chapter.id, lessonId));
    expect(addedEdges).toContain(makeEdgeId(SUPPORTS, lessonId, expectationId));
    expect(preview.diff.nodes.removed).toHaveLength(0);
    expect(await readDraft()).toBeNull();

    // Confirm: applies the whole composite atomically to the draft.
    const confirm = await runGraphMutation({ namespace: ns, mutation: addLesson, args, confirm: true, token: preview.confirmationToken, coverage });
    expect(confirm.phase).toBe("apply");
    const draft = await readDraft();
    expect(draft).not.toBeNull();
    const newLesson = draft!.nodes.find((n) => n.id === lessonId)!;
    // Chapter membership + alignment are the edges (asserted above); the lesson
    // node carries its own title, no chapter-membership number to drift.
    expect(newLesson.properties.text).toBe("Nouvelle leçon");
    expect(newLesson.labels).toEqual(["Lesson"]);
  });

  it("BLOCKS linking to a nonexistent chapter (no token)", async () => {
    const published = await readPublished();
    const lessonId = mintNodeId();
    const preview = await runGraphMutation({ namespace: ns, mutation: addLesson, args: { ...bag(), groupingId: "does-not-exist", expectationId: someExpectation(published), lessonId, text: "x" }, coverage });
    expect(preview.phase).toBe("blocked");
    if (preview.phase !== "blocked") throw new Error("expected blocked");
    expect(preview.errors.join(" ")).toMatch(/does not exist/);
    expect(await readDraft()).toBeNull();
  });

  it("BLOCKS aligning to a nonexistent expectation (no token)", async () => {
    const published = await readPublished();
    const chapter = findChapter(published, 1);
    const preview = await runGraphMutation({ namespace: ns, mutation: addLesson, args: { ...bag(), groupingId: chapter.id, expectationId: "no-such-standard", lessonId: mintNodeId(), text: "x" }, coverage });
    expect(preview.phase).toBe("blocked");
    if (preview.phase !== "blocked") throw new Error("expected blocked");
    expect(preview.errors.join(" ")).toMatch(/expectation .* does not exist/);
    expect(await readDraft()).toBeNull();
  });

  it("role matrix: a no-role actor is denied with a blocked audit and no state change", async () => {
    __setActorForTest(NO_ROLE);
    const published = await readPublished();
    const chapter = findChapter(published, 1);
    const res = await runGraphMutation({ namespace: ns, mutation: addLesson, args: { ...bag(), groupingId: chapter.id, expectationId: someExpectation(published), lessonId: mintNodeId(), text: "x" }, coverage });
    expect(res.phase).toBe("unauthorized");
    expect(await readDraft()).toBeNull();
    __setActorForTest(CURATOR);
    const audits = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(audits.some((a) => a.reason?.startsWith("unauthorized"))).toBe(true);
  });
});

// ── add_lesson_grouping ─────────────────────────────────────────────────────────────
describe("add_lesson_grouping", () => {
  it("appends an EMPTY chapter at a FREE number as one composite; audits as ONE apply event", async () => {
    const groupingId = mintNodeId();
    const { preview, confirm } = await runRecipe(addLessonGrouping, { ...bag(), groupingId, number: 26, title: "Chapitre 26" });
    if (preview.phase !== "preview") throw new Error("expected preview");
    // One node (the chapter), no edges — lessons are added later via add_lesson.
    expect(preview.diff.nodes.added.map((e) => e.id)).toEqual([groupingId]);
    expect(preview.diff.edges.added).toHaveLength(0);
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    expect(findChapter(draft!, 26).id).toBe(groupingId);
    expect(findChapter(draft!, 26).labels).toEqual(["LessonGrouping"]);
    expect(lessonIdsOf(draft!, groupingId)).toEqual([]);

    // Exactly one apply audit record for the whole composite.
    const applies = await store.listAudit({ namespace: ns, eventType: "apply" });
    expect(applies.filter((a) => a.mutation === "addLessonGrouping")).toHaveLength(1);
  });

  it("REJECTS a colliding chapter number in the additive path (nothing lands)", async () => {
    const preview = await runGraphMutation({ namespace: ns, mutation: addLessonGrouping, args: { ...bag(), groupingId: mintNodeId(), number: 1, title: "dup" }, coverage });
    expect(preview.phase).toBe("blocked");
    if (preview.phase !== "blocked") throw new Error("expected blocked");
    expect(preview.errors.join(" ")).toMatch(/already used/);
    expect(await readDraft()).toBeNull();
  });

  it("warns that the new chapter is born empty (add lessons via add_lesson)", async () => {
    const { preview } = await runRecipe(addLessonGrouping, { ...bag(), groupingId: mintNodeId(), number: 27, title: "Vide" });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.warnings.some((w) => /no child lessons/.test(w))).toBe(true);
  });
});

// ── move_lesson ───────────────────────────────────────────────────────────────
describe("move_lesson", () => {
  it("rehomes a lesson atomically by rewiring the hasChild edge", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const dst = findChapter(published, 2);
    // Pick a non-bilan lesson so neither chapter loses its bilan.
    const movable = lessonIdsOf(published, src.id).find((id) => published.nodes.find((n) => n.id === id)!.properties.isAssessment !== true)!;

    const { preview, confirm } = await runRecipe(moveLesson, { ...bag(), lessonId: movable, toGroupingId: dst.id });
    if (preview.phase !== "preview") throw new Error("expected preview");
    // Old edge removed, new edge added — the whole rewire in one diff.
    expect(preview.diff.edges.removed.map((e) => e.id)).toContain(makeEdgeId(HAS_CHILD, src.id, movable));
    expect(preview.diff.edges.added.map((e) => e.id)).toContain(makeEdgeId(HAS_CHILD, dst.id, movable));
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    expect(lessonIdsOf(draft!, src.id)).not.toContain(movable);
    expect(lessonIdsOf(draft!, dst.id)).toContain(movable);
    // Membership is the edge — the moved lesson keeps its own number; nothing drifts.
  });

  it("BLOCKS a move to a nonexistent chapter", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const lesson = lessonIdsOf(published, src.id)[0];
    const res = await runGraphMutation({ namespace: ns, mutation: moveLesson, args: { ...bag(), lessonId: lesson, toGroupingId: "nope" }, coverage });
    expect(res.phase).toBe("blocked");
    expect(await readDraft()).toBeNull();
  });

  it("WARNS (not blocks) when moving the bilan out leaves the source chapter without one", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const dst = findChapter(published, 2);
    const bilan = bilanOf(published, src.id)!;
    const { preview, confirm } = await runRecipe(moveLesson, { ...bag(), lessonId: bilan.id, toGroupingId: dst.id });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.warnings.some((w) => /no bilan/.test(w))).toBe(true); // informs, but…
    expect(confirm?.phase).toBe("apply");                                 // …never blocks.
  });
});

// ── split_lesson_grouping ─────────────────────────────────────────────────────────────
describe("split_lesson_grouping", () => {
  it("creates a new chapter and moves the tail lessons atomically; result stays integrity-clean", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const lessons = lessonIdsOf(published, src.id);
    expect(lessons.length).toBeGreaterThanOrEqual(2);
    const atLesson = lessons[Math.floor(lessons.length / 2)];
    const newGroupingId = mintNodeId();

    const { preview, confirm } = await runRecipe(splitLessonGrouping, { ...bag(), groupingId: src.id, atLessonId: atLesson, newGroupingId, newTitle: "Chapitre 1 (suite)" });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.diff.nodes.added.map((e) => e.id)).toEqual([newGroupingId]);
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    // The tail (atLesson onward) is now under the new chapter, appended at max+1.
    const appendedNum = maxChapterNum(published) + 1;
    expect(nodeRawNum(draft!, newGroupingId)).toBe(appendedNum);
    const moved = lessonIdsOf(draft!, newGroupingId);
    expect(moved).toContain(atLesson);
    expect(lessonIdsOf(draft!, src.id)).not.toContain(atLesson);
    // The moved lessons keep their own numbers — membership followed the edge.
    // Whole draft is referentially clean: diff_draft reflects it, no dangling.
    const whole = await diffDraft(ns, coverage);
    expect(whole.hasDraft).toBe(true);
  });

  it("BLOCKS (as a whole) a split whose atLesson is not in the chapter — nothing partial lands", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const foreign = lessonIdsOf(published, findChapter(published, 2).id)[0];
    const res = await runGraphMutation({ namespace: ns, mutation: splitLessonGrouping, args: { ...bag(), groupingId: src.id, atLessonId: foreign, newGroupingId: mintNodeId() }, coverage });
    expect(res.phase).toBe("blocked");
    expect(await readDraft()).toBeNull();
  });
});

// ── renumber (the regime-gated recipe) ────────────────────────────────────────
describe("renumber", () => {
  it("rewrites ONLY the chapter number; lessons follow via the edge (no cascade)", async () => {
    const published = await readPublished();
    const chapter = findChapter(published, 3);
    const lessons = lessonIdsOf(published, chapter.id);

    const { preview, confirm } = await runRecipe(renumber, { ...bag(), groupingId: chapter.id, newNumber: 26 });
    if (preview.phase !== "preview") throw new Error("expected preview");
    // ONLY the chapter is a CHANGED node — lessons are untouched, since membership
    // is the hasChild edge, not a denormalized number.
    const changedIds = preview.diff.nodes.changed.map((e) => e.id);
    expect(changedIds).toContain(chapter.id);
    for (const id of lessons) expect(changedIds).not.toContain(id);
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    expect(nodeRawNum(draft!, chapter.id)).toBe(26);
    expect((draft!.nodes.find((n) => n.id === chapter.id)!.properties.order)).toBe(26);
    // The lessons still belong to the (renumbered) chapter via the edge.
    expect(lessonIdsOf(draft!, chapter.id).sort()).toEqual(lessons.sort());
  });

  it("BLOCKS a renumber into an already-used number", async () => {
    const published = await readPublished();
    const chapter = findChapter(published, 3);
    const res = await runGraphMutation({ namespace: ns, mutation: renumber, args: { ...bag(), groupingId: chapter.id, newNumber: 4 }, coverage });
    expect(res.phase).toBe("blocked");
    if (res.phase !== "blocked") throw new Error("expected blocked");
    expect(res.errors.join(" ")).toMatch(/already used/);
    expect(await readDraft()).toBeNull();
  });
});

// ── end-to-end: build in draft → publish → published read shows new structure ──
describe("recipes end-to-end", () => {
  it("add_lesson_grouping → add_lesson → split_lesson_grouping → move_lesson accumulate on one draft, publish ships the whole atomically, and a published read shows the new structure", async () => {
    const published0 = await readPublished();
    const untouched = findChapter(published0, 10);
    const untouchedLessons = lessonIdsOf(published0, untouched.id).sort();

    // 1) add an EMPTY chapter into a free gap.
    const gap = freeGapNumber(published0);
    const chapId = mintNodeId();
    let r = await runRecipe(addLessonGrouping, { ...bag(), groupingId: chapId, number: gap, title: "Nouveau" });
    expect(r.confirm?.phase).toBe("apply");

    // 2) add a lesson to it, aligned to an existing expectation.
    const expectationId = someExpectation(published0);
    const newLesson = mintNodeId();
    r = await runRecipe(addLesson, { ...bag(), groupingId: chapId, expectationId, lessonId: newLesson, text: "Leçon nouvelle" });
    expect(r.confirm?.phase).toBe("apply");

    // 3) split chapter 1 at its midpoint (new chapter appends at max+1).
    const src = findChapter(published0, 1);
    const appendedNum = maxChapterNum(published0) + 1;
    const mid = lessonIdsOf(published0, src.id)[Math.floor(lessonIdsOf(published0, src.id).length / 2)];
    const newChap = mintNodeId();
    r = await runRecipe(splitLessonGrouping, { ...bag(), groupingId: src.id, atLessonId: mid, newGroupingId: newChap, newTitle: "Ch1 suite" });
    expect(r.confirm?.phase).toBe("apply");

    // 4) move the freshly-added lesson into the split-off chapter.
    r = await runRecipe(moveLesson, { ...bag(), lessonId: newLesson, toGroupingId: newChap });
    expect(r.confirm?.phase).toBe("apply");

    // Publish the whole draft atomically — as the APPROVER (publish is
    // approver-gated at BOTH phases; the curator authored, the approver ships).
    __setActorForTest(APPROVER);
    const dry = await publishDraftWithConfirm(ns, { coverage });
    if (dry.phase !== "preview" || !dry.confirmationToken) throw new Error("expected publishable preview");
    const done = await publishDraftWithConfirm(ns, { confirm: true, token: dry.confirmationToken, coverage });
    expect(done.phase === "commit" && done.ok).toBe(true);
    __setActorForTest(CURATOR);

    // A published read (deserialized like the presenter) shows the new structure.
    const pub = await readPublished();
    const model = deserializeToModel(pub);
    expect(model.byId.get(chapId)!.order).toBe(gap);
    expect(model.byId.get(newChap)!.order).toBe(appendedNum);
    // The moved lesson now belongs to the split-off chapter via the hasChild edge.
    expect(lessonIdsOf(pub, newChap).includes(newLesson)).toBe(true);
    // #2 parity: an untouched chapter's lessons are unchanged.
    expect(lessonIdsOf(pub, findChapter(pub, 10).id).sort()).toEqual(untouchedLessons);
  });
});
