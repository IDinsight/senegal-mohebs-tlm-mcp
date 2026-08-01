// ── The recipe registry — the MIRROR get_capabilities declares (#14 decision f) ─
// One descriptor per recipe. get_capabilities renders THIS array (never a
// hand-authored copy), so what Claude discovers can't drift from what's built.
// `renumberBearing` marks a recipe that changes an EXISTING chapter's number;
// `regimeGated` marks one whose correctness depends on the Regime-B
// `chapitreNum` cascade (move/split/renumber rewrite it; add_* set it at birth).

export type RecipeParam = { name: string; required: boolean; note?: string };
export type RecipeDescriptor = {
  name: string;
  summary: string;
  params: RecipeParam[];
  renumberBearing: boolean;
  regimeGated: boolean;
};

export const RECIPES: readonly RecipeDescriptor[] = [
  {
    name: "add_lesson",
    summary: "Create a lesson and link it to an existing chapter (additive). Sets the lesson's chapter-membership number so it renders under that chapter.",
    params: [
      { name: "chapterId", required: true },
      { name: "text", required: true, note: "the lesson objective" },
      { name: "text_en", required: false },
      { name: "order", required: false, note: "within-chapter position; defaults to appending at the end" },
      { name: "isBilan", required: false, note: "mark this lesson as the end-of-chapter assessment" },
    ],
    renumberBearing: false,
    regimeGated: false,
  },
  {
    name: "add_chapter",
    summary: "Create a chapter (title + number at birth) with optional seed lessons, as one composite. The number must be FREE (append or fill a gap); a colliding number is rejected.",
    params: [
      { name: "number", required: true, note: "must be a free chapter number (append/gap-fill only)" },
      { name: "title", required: true },
      { name: "title_en", required: false },
      { name: "lessons", required: false, note: "array of { text, text_en?, isBilan? } seed lessons" },
    ],
    renumberBearing: false,
    regimeGated: false,
  },
  {
    name: "move_lesson",
    summary: "Rehome a lesson from its current chapter to another (unlink + relink) and rewrite its chapter-membership number. Numbers are preserved; appends to the target by default.",
    params: [
      { name: "lessonId", required: true },
      { name: "toChapterId", required: true },
      { name: "position", required: false, note: "within-target position; defaults to appending at the end" },
    ],
    renumberBearing: false,
    regimeGated: true,
  },
  {
    name: "split_chapter",
    summary: "Create a new chapter and move the tail lessons (from atLesson onward) into it, atomically. The new chapter is appended at the next free number by default (no shift of existing chapters).",
    params: [
      { name: "chapterId", required: true },
      { name: "atLessonId", required: true, note: "first lesson (inclusive) to move to the new chapter" },
      { name: "newTitle", required: false, note: "defaults to '<source title> (suite)'" },
      { name: "newTitle_en", required: false },
      { name: "newNumber", required: false, note: "must be a free number; omit to append at the end" },
    ],
    renumberBearing: false,
    regimeGated: true,
  },
  {
    name: "renumber",
    summary: "Change a chapter's number and cascade-rewrite every child lesson's chapter-membership number in one atomic composite, so nothing drifts. The target number must be FREE (no shift or swap).",
    params: [
      { name: "chapterId", required: true },
      { name: "newNumber", required: true, note: "must be a free chapter number" },
    ],
    renumberBearing: true,
    regimeGated: true,
  },
];
