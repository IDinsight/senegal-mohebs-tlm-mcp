// ── Module: kg-store · recipes (#14) — barrel ────────────────────────────────
// Curriculum RECIPES — named, curriculum-meaningful COMPOSITE operations. Each
// recipe is a SINGLE #5 GraphMutation whose `apply` performs many create/link/
// unlink + structural-property edits internally and atomically, so one intent →
// one whole-composite diff → one confirmation token → one atomic draft write →
// one #7 audit event → gated by #8. Recipes are the ergonomic layer OVER the #12
// primitives, made safe by #13's full integrity floor:
//
//   • They REUSE #12's pure primitive `apply` functions (createNode / linkNodes
//     / unlinkNodes) by composing them — a recipe is literally several
//     primitives folded together, never Claude orchestrating separate tool
//     calls (which would reintroduce confirmation fatigue + partial-draft risk).
//   • The framework runs #13's `validateStructural` (Rule 1 id-immutable,
//     Rule 2 no-orphan) on the WHOLE resulting draft — an invalid composite
//     (e.g. a move that would dangle an edge) is rejected as a WHOLE, nothing
//     partial lands. Each recipe adds its own preflight `validate` for the
//     curriculum-level preconditions the structural rules can't see.
//   • Coverage WARNINGS (#13) ride the normal preview envelope — a split that
//     leaves a chapter without a bilan warns, never blocks.
//
// Subject-agnosticism: kg-store never names "chapter"/"lesson"/"hasChild". Each
// recipe reads that vocabulary from a `RecipeProfile` + `structuralAliases` +
// `wordingAliases` threaded through its args (see ./shared.ts). The server tool
// layer reads them off the active adapter. A subject with no `recipeProfile`
// simply has no recipes.
//
// Layout: one file per recipe (add-lesson / add-lesson-grouping / move-lesson /
// split-lesson-grouping / renumber), the shared toolkit they compose from (shared.ts),
// the structural-property edit path move/split/renumber share (structural-edit.ts),
// and the get_capabilities mirror (registry.ts).

export { addLesson, type AddLessonArgs } from "./add-lesson.js";
export { addLessonGrouping, type AddLessonGroupingArgs } from "./add-lesson-grouping.js";
export { moveLesson, type MoveLessonArgs } from "./move-lesson.js";
export { splitLessonGrouping, type SplitLessonGroupingArgs } from "./split-lesson-grouping.js";
export { renumber, type RenumberArgs } from "./renumber.js";
// Scope C content-layer recipes (Activity / Material inside a lesson).
export { addActivity, type AddActivityArgs } from "./add-activity.js";
export { addMaterial, type AddMaterialArgs } from "./add-material.js";
export { setMaterialContent, type SetMaterialContentArgs } from "./set-material-content.js";

export { STRUCTURAL_EDIT_SAFE_PATHS, structuralEditErrors, editStructural } from "./structural-edit.js";

export { RECIPES, type RecipeDescriptor, type RecipeParam } from "./registry.js";
