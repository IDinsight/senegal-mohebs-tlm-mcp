// ── The recipe registry — the MIRROR get_capabilities declares (#14 decision f) ─
// One descriptor per recipe. get_capabilities renders THIS array (never a
// hand-authored copy), so what Claude discovers can't drift from what's built.
// `renumberBearing` marks a recipe that changes an EXISTING chapter's number.
// (Chapter↔lesson membership is the hasChild edge, so there is no number cascade
// to flag — the old CI maths "Regime-B" join key is gone.)

export type RecipeParam = { name: string; required: boolean; note?: string };
export type RecipeDescriptor = {
  name: string;
  summary: string;
  params: RecipeParam[];
  renumberBearing: boolean;
};

export const RECIPES: readonly RecipeDescriptor[] = [
  {
    name: "add_lesson",
    summary: "Create a lesson, link it to an existing chapter, and align it (supports) to an existing spine expectation (the objective it teaches). Additive — the chapter and the expectation must already exist.",
    params: [
      { name: "groupingId", required: true },
      { name: "expectationId", required: true, note: "the existing standard (OS) this lesson aligns to" },
      { name: "text", required: true, note: "the lesson's own title (the OS text lives on the expectation)" },
      { name: "text_en", required: false },
      { name: "order", required: false, note: "within-chapter position; defaults to appending at the end" },
      { name: "isBilan", required: false, note: "mark this lesson as the end-of-chapter assessment" },
    ],
    renumberBearing: false,
  },
  {
    name: "add_lesson_grouping",
    summary: "Create a lesson grouping (an LC LessonGrouping — Chapitre / Unité / Module…), title + number at birth, as one composite. Created EMPTY (add lessons via add_lesson). The number must be FREE (append or fill a gap); a colliding number is rejected.",
    params: [
      { name: "number", required: true, note: "position in the series; must be a free number (append/gap-fill only)" },
      { name: "title", required: true },
      { name: "title_en", required: false },
      { name: "groupName", required: false, note: "the grouping TYPE (LC groupName); defaults to \"Chapitre\"" },
    ],
    renumberBearing: false,
  },
  {
    name: "move_lesson",
    summary: "Rehome a lesson from its current chapter to another (unlink + relink the hasChild edge). Appends to the target by default; the lesson keeps its own number.",
    params: [
      { name: "lessonId", required: true },
      { name: "toGroupingId", required: true },
      { name: "position", required: false, note: "within-target position; defaults to appending at the end" },
    ],
    renumberBearing: false,
  },
  {
    name: "split_lesson_grouping",
    summary: "Create a new lesson grouping (same type as the source) and move the tail lessons (from atLesson onward) into it, atomically. The new grouping is appended at the next free number by default (no shift of existing groupings).",
    params: [
      { name: "groupingId", required: true, note: "the grouping being split" },
      { name: "atLessonId", required: true, note: "first lesson (inclusive) to move to the new grouping" },
      { name: "newTitle", required: false, note: "defaults to '<source title> (suite)'" },
      { name: "newTitle_en", required: false },
      { name: "newNumber", required: false, note: "must be a free number; omit to append at the end" },
    ],
    renumberBearing: false,
  },
  {
    name: "renumber",
    summary: "Change a chapter's number. Lessons follow via the hasChild edge — no cascade. The target number must be FREE (no shift or swap).",
    params: [
      { name: "groupingId", required: true },
      { name: "newNumber", required: true, note: "must be a free chapter number" },
    ],
    renumberBearing: true,
  },
];
