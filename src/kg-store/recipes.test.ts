// ── #14 curriculum recipes — tests ───────────────────────────────────────────
// Drives add_lesson / add_chapter / move_lesson / split_chapter / renumber
// through the #5 framework end to end, on the real CI-maths seed. Acceptance
// criteria mirror the task spec:
//
//   • Each recipe: dry-run = ONE whole-composite diff + token, NO state change;
//     confirm applies the WHOLE composite ATOMICALLY to the draft; #7 audits it
//     as ONE event; curator-gated.
//   • add_lesson: composite (lesson + hasChild); nonexistent chapter BLOCKED.
//   • add_chapter: append/gap-fill works; colliding number rejected.
//   • move_lesson: rehomed atomically; chapitreNum rewritten (no drift);
//     nonexistent target blocked; coverage warns (bilan moved out).
//   • split_chapter: new chapter + tail moved atomically; integrity-clean;
//     a split leaving a chapter without a bilan WARNS (not blocks).
//   • renumber: chapter number + every child lesson's chapitreNum rewritten
//     atomically (Regime-B), no drift warning; collision BLOCKED.
//   • Composite atomicity: an invalid composite lands NOTHING partial.
//   • End-to-end: add → split → move in draft → publish → published read shows
//     the new structure; untouched chapters unchanged (parity).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../config.js";
import { listAvailableContexts, subjectDir } from "../context/index.js";
import { resolveAdapter } from "../adapters/index.js";
import { serializeModel, deserializeToModel } from "../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, publishDraftWithConfirm, diffDraft, mintNodeId,
  addLesson, addChapter, moveLesson, splitChapter, renumber, edgeId as makeEdgeId,
  __resetMutationsForTest, __resetDraftTokensForTest,
} from "./index.js";
import { __setStorageForTest } from "../storage/index.js";
import { __setActorForTest, type Actor } from "../actor.js";
import type { MutationGraph, GraphMutation } from "./index.js";
import type { KgNodeStore, StoredMeta } from "./types.js";
import type { StorageAdapter, HistoryFile, RecipeProfile, StructuralAliases, WordingAliases } from "../types.js";

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
const chapterNum = (n: { properties: Record<string, unknown> }): number | undefined => (n.properties.raw as Record<string, unknown> | undefined)?.chapitreNum as number | undefined;
const findChapter = (g: MutationGraph, num: number) => g.nodes.find((n) => n.type === "chapter" && chapterNum(n) === num)!;
const lessonIdsOf = (g: MutationGraph, chapterId: string) =>
  g.edges.filter((e) => e.type === HAS_CHILD && e.from === chapterId).map((e) => e.to).filter((id) => g.nodes.find((n) => n.id === id)?.type === "lesson");
const bilanOf = (g: MutationGraph, chapterId: string) =>
  lessonIdsOf(g, chapterId).map((id) => g.nodes.find((n) => n.id === id)!).find((n) => n.properties.isAssessment === true);
const nodeRawNum = (g: MutationGraph, id: string): number | undefined => chapterNum(g.nodes.find((n) => n.id === id)!);
// The seed numbers chapters 1..13,15..25,29 — so the next append number is
// max+1 and 26/27/28 are free gaps. Computed, never hardcoded, so the tests
// stay honest against the real data.
const maxChapterNum = (g: MutationGraph): number => Math.max(...g.nodes.filter((n) => n.type === "chapter").map((n) => chapterNum(n) ?? 0));
const freeGapNumber = (g: MutationGraph): number => { const used = new Set(g.nodes.filter((n) => n.type === "chapter").map((n) => chapterNum(n))); let k = 1; while (used.has(k)) k++; return k; };

// Common recipe-arg bag (the subject vocabulary the server tool would supply).
const bag = () => ({ namespace: ns, profile: profile(), structuralAliases: sAliases(), wordingAliases: wAliases() });

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
  it("is ONE composite (lesson node + hasChild edge); dry-run changes no state; confirm applies atomically", async () => {
    const published = await readPublished();
    const chapter = findChapter(published, 1);
    const lessonId = mintNodeId();
    const args = { ...bag(), chapterId: chapter.id, lessonId, text: "Nouvelle leçon", isBilan: false };

    // Dry-run: one whole-composite diff + token, NO state change.
    const preview = await runGraphMutation({ namespace: ns, mutation: addLesson, args, coverage });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.diff.nodes.added.map((e) => e.id)).toEqual([lessonId]);
    expect(preview.diff.edges.added.map((e) => e.id)).toEqual([makeEdgeId(HAS_CHILD, chapter.id, lessonId)]);
    expect(preview.diff.nodes.removed).toHaveLength(0);
    expect(await readDraft()).toBeNull();

    // Confirm: applies the whole composite atomically to the draft.
    const confirm = await runGraphMutation({ namespace: ns, mutation: addLesson, args, confirm: true, token: preview.confirmationToken, coverage });
    expect(confirm.phase).toBe("apply");
    const draft = await readDraft();
    expect(draft).not.toBeNull();
    const newLesson = draft!.nodes.find((n) => n.id === lessonId)!;
    // Regime-aware: the new lesson's chapitreNum matches its chapter, so it is
    // NOT drifting — no drift warning fires.
    expect(nodeRawNum(draft!, lessonId)).toBe(1);
    expect((newLesson.properties.raw as Record<string, unknown>).osTexte).toBe("Nouvelle leçon");
    expect(coverage(draft!).some((w) => /disagrees|will not render/.test(w))).toBe(false);
  });

  it("BLOCKS linking to a nonexistent chapter (no token)", async () => {
    const lessonId = mintNodeId();
    const preview = await runGraphMutation({ namespace: ns, mutation: addLesson, args: { ...bag(), chapterId: "does-not-exist", lessonId, text: "x" }, coverage });
    expect(preview.phase).toBe("blocked");
    if (preview.phase !== "blocked") throw new Error("expected blocked");
    expect(preview.errors.join(" ")).toMatch(/does not exist/);
    expect(await readDraft()).toBeNull();
  });

  it("role matrix: a no-role actor is denied with a blocked audit and no state change", async () => {
    __setActorForTest(NO_ROLE);
    const published = await readPublished();
    const chapter = findChapter(published, 1);
    const res = await runGraphMutation({ namespace: ns, mutation: addLesson, args: { ...bag(), chapterId: chapter.id, lessonId: mintNodeId(), text: "x" }, coverage });
    expect(res.phase).toBe("unauthorized");
    expect(await readDraft()).toBeNull();
    __setActorForTest(CURATOR);
    const audits = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(audits.some((a) => a.reason?.startsWith("unauthorized"))).toBe(true);
  });
});

// ── add_chapter ─────────────────────────────────────────────────────────────
describe("add_chapter", () => {
  it("appends at a FREE number with seed lessons as one composite; audits as ONE apply event", async () => {
    const chapterId = mintNodeId();
    const lessonIds = [mintNodeId(), mintNodeId()];
    const { preview, confirm } = await runRecipe(addChapter, {
      ...bag(), chapterId, number: 26, title: "Chapitre 26", lessonIds,
      lessons: [{ text: "Leçon A" }, { text: "Bilan", isBilan: true }],
    });
    if (preview.phase !== "preview") throw new Error("expected preview");
    // One composite: 3 nodes (chapter + 2 lessons) + 2 hasChild edges.
    expect(preview.diff.nodes.added.map((e) => e.id).sort()).toEqual([chapterId, ...lessonIds].sort());
    expect(preview.diff.edges.added).toHaveLength(2);
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    expect(findChapter(draft!, 26).id).toBe(chapterId);
    expect(lessonIdsOf(draft!, chapterId).sort()).toEqual([...lessonIds].sort());
    // A seed lesson marked isBilan → no missing-bilan warning for this chapter.
    expect(coverage(draft!).some((w) => /Chapitre 26.*no bilan/.test(w))).toBe(false);

    // Exactly one apply audit record for the whole composite.
    const applies = await store.listAudit({ namespace: ns, eventType: "apply" });
    expect(applies.filter((a) => a.mutation === "addChapter")).toHaveLength(1);
  });

  it("REJECTS a colliding chapter number in the additive path (nothing lands)", async () => {
    const preview = await runGraphMutation({ namespace: ns, mutation: addChapter, args: { ...bag(), chapterId: mintNodeId(), number: 1, title: "dup", lessonIds: [] }, coverage });
    expect(preview.phase).toBe("blocked");
    if (preview.phase !== "blocked") throw new Error("expected blocked");
    expect(preview.errors.join(" ")).toMatch(/already used/);
    expect(await readDraft()).toBeNull();
  });

  it("warns (not blocks) when a chapter is created with no lessons at all", async () => {
    const { preview } = await runRecipe(addChapter, { ...bag(), chapterId: mintNodeId(), number: 27, title: "Vide", lessonIds: [] });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.warnings.some((w) => /no child lessons/.test(w))).toBe(true);
  });
});

// ── move_lesson ───────────────────────────────────────────────────────────────
describe("move_lesson", () => {
  it("rehomes a lesson atomically and rewrites its chapitreNum (no drift)", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const dst = findChapter(published, 2);
    // Pick a non-bilan lesson so neither chapter loses its bilan.
    const movable = lessonIdsOf(published, src.id).find((id) => published.nodes.find((n) => n.id === id)!.properties.isAssessment !== true)!;

    const { preview, confirm } = await runRecipe(moveLesson, { ...bag(), lessonId: movable, toChapterId: dst.id });
    if (preview.phase !== "preview") throw new Error("expected preview");
    // Old edge removed, new edge added — the whole rewire in one diff.
    expect(preview.diff.edges.removed.map((e) => e.id)).toContain(makeEdgeId(HAS_CHILD, src.id, movable));
    expect(preview.diff.edges.added.map((e) => e.id)).toContain(makeEdgeId(HAS_CHILD, dst.id, movable));
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    expect(lessonIdsOf(draft!, src.id)).not.toContain(movable);
    expect(lessonIdsOf(draft!, dst.id)).toContain(movable);
    // Mandatory Regime-B rewrite: the moved lesson now joins chapter 2.
    expect(nodeRawNum(draft!, movable)).toBe(2);
    expect(coverage(draft!).some((w) => w.includes(movable) && /disagrees|will not render/.test(w))).toBe(false);
  });

  it("BLOCKS a move to a nonexistent chapter", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const lesson = lessonIdsOf(published, src.id)[0];
    const res = await runGraphMutation({ namespace: ns, mutation: moveLesson, args: { ...bag(), lessonId: lesson, toChapterId: "nope" }, coverage });
    expect(res.phase).toBe("blocked");
    expect(await readDraft()).toBeNull();
  });

  it("WARNS (not blocks) when moving the bilan out leaves the source chapter without one", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const dst = findChapter(published, 2);
    const bilan = bilanOf(published, src.id)!;
    const { preview, confirm } = await runRecipe(moveLesson, { ...bag(), lessonId: bilan.id, toChapterId: dst.id });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.warnings.some((w) => /no bilan/.test(w))).toBe(true); // informs, but…
    expect(confirm?.phase).toBe("apply");                                 // …never blocks.
  });
});

// ── split_chapter ─────────────────────────────────────────────────────────────
describe("split_chapter", () => {
  it("creates a new chapter and moves the tail lessons atomically; result stays integrity-clean", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const lessons = lessonIdsOf(published, src.id);
    expect(lessons.length).toBeGreaterThanOrEqual(2);
    const atLesson = lessons[Math.floor(lessons.length / 2)];
    const newChapterId = mintNodeId();

    const { preview, confirm } = await runRecipe(splitChapter, { ...bag(), chapterId: src.id, atLessonId: atLesson, newChapterId, newTitle: "Chapitre 1 (suite)" });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.diff.nodes.added.map((e) => e.id)).toEqual([newChapterId]);
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    // The tail (atLesson onward) is now under the new chapter, appended at max+1.
    const appendedNum = maxChapterNum(published) + 1;
    expect(nodeRawNum(draft!, newChapterId)).toBe(appendedNum);
    const moved = lessonIdsOf(draft!, newChapterId);
    expect(moved).toContain(atLesson);
    expect(lessonIdsOf(draft!, src.id)).not.toContain(atLesson);
    // Every moved lesson's chapitreNum was rewritten to the new chapter → no drift.
    for (const id of moved) expect(nodeRawNum(draft!, id)).toBe(appendedNum);
    // Whole draft is referentially clean: diff_draft reflects it, no dangling.
    const whole = await diffDraft(ns, coverage);
    expect(whole.hasDraft).toBe(true);
    expect(coverage(draft!).some((w) => /will not render|disagrees/.test(w))).toBe(false);
  });

  it("BLOCKS (as a whole) a split whose atLesson is not in the chapter — nothing partial lands", async () => {
    const published = await readPublished();
    const src = findChapter(published, 1);
    const foreign = lessonIdsOf(published, findChapter(published, 2).id)[0];
    const res = await runGraphMutation({ namespace: ns, mutation: splitChapter, args: { ...bag(), chapterId: src.id, atLessonId: foreign, newChapterId: mintNodeId() }, coverage });
    expect(res.phase).toBe("blocked");
    expect(await readDraft()).toBeNull();
  });
});

// ── renumber (the regime-gated recipe) ────────────────────────────────────────
describe("renumber", () => {
  it("rewrites the chapter number AND every child lesson's chapitreNum atomically → no drift", async () => {
    const published = await readPublished();
    const chapter = findChapter(published, 3);
    const lessons = lessonIdsOf(published, chapter.id);

    const { preview, confirm } = await runRecipe(renumber, { ...bag(), chapterId: chapter.id, newNumber: 26 });
    if (preview.phase !== "preview") throw new Error("expected preview");
    // The chapter + every child lesson show up as CHANGED nodes (numbers rewritten).
    const changedIds = preview.diff.nodes.changed.map((e) => e.id);
    expect(changedIds).toContain(chapter.id);
    for (const id of lessons) expect(changedIds).toContain(id);
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    expect(nodeRawNum(draft!, chapter.id)).toBe(26);
    expect((draft!.nodes.find((n) => n.id === chapter.id)!.properties.order)).toBe(26);
    for (const id of lessons) expect(nodeRawNum(draft!, id)).toBe(26);
    // The family stays consistent → the Regime-B drift warning does NOT fire.
    expect(coverage(draft!).some((w) => /disagrees|will not render/.test(w))).toBe(false);
  });

  it("BLOCKS a renumber into an already-used number", async () => {
    const published = await readPublished();
    const chapter = findChapter(published, 3);
    const res = await runGraphMutation({ namespace: ns, mutation: renumber, args: { ...bag(), chapterId: chapter.id, newNumber: 4 }, coverage });
    expect(res.phase).toBe("blocked");
    if (res.phase !== "blocked") throw new Error("expected blocked");
    expect(res.errors.join(" ")).toMatch(/already used/);
    expect(await readDraft()).toBeNull();
  });
});

// ── end-to-end: build in draft → publish → published read shows new structure ──
describe("recipes end-to-end", () => {
  it("add_chapter → split_chapter → move_lesson accumulate on one draft, publish ships the whole atomically, and a published read shows the new structure", async () => {
    const published0 = await readPublished();
    const untouched = findChapter(published0, 10);
    const untouchedLessons = lessonIdsOf(published0, untouched.id).sort();

    // 1) add a chapter into a free gap (14) with two lessons.
    const gap = freeGapNumber(published0);
    const chapId = mintNodeId(); const lIds = [mintNodeId(), mintNodeId()];
    let r = await runRecipe(addChapter, { ...bag(), chapterId: chapId, number: gap, title: "Nouveau", lessonIds: lIds, lessons: [{ text: "L1" }, { text: "Bilan", isBilan: true }] });
    expect(r.confirm?.phase).toBe("apply");

    // 2) split chapter 1 at its midpoint (new chapter appends at max+1).
    const src = findChapter(published0, 1);
    const appendedNum = maxChapterNum(published0) + 1;
    const mid = lessonIdsOf(published0, src.id)[Math.floor(lessonIdsOf(published0, src.id).length / 2)];
    const newChap = mintNodeId();
    r = await runRecipe(splitChapter, { ...bag(), chapterId: src.id, atLessonId: mid, newChapterId: newChap, newTitle: "Ch1 suite" });
    expect(r.confirm?.phase).toBe("apply");

    // 3) move one of the gap-chapter's lessons into the split-off chapter.
    r = await runRecipe(moveLesson, { ...bag(), lessonId: lIds[0], toChapterId: newChap });
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
    expect(model.byId.get(chapId)!.properties.chapitreNum).toBe(gap);
    expect(model.byId.get(newChap)!.properties.chapitreNum).toBe(appendedNum);
    // The moved lesson now joins the split-off chapter (Regime-B key rewritten).
    expect((model.byId.get(lIds[0])!.properties.chapitreNum)).toBe(appendedNum);
    // #2 parity: an untouched chapter's lessons are unchanged.
    expect(lessonIdsOf(pub, findChapter(pub, 10).id).sort()).toEqual(untouchedLessons);
  });
});
