// ── Recipe: renumber ──────────────────────────────────────────────────────────
// Structural-property edit of a chapter's number — the ONE recipe whose safety
// is fully determined by the #13 regime finding. It rewrites the chapter's
// `number` (order + raw.chapitreNum) AND cascade-rewrites every child lesson's
// chapter-membership number (raw.chapitreNum) in the SAME atomic composite, so
// the family stays consistent and no `chapitreNum` drift warning fires. The
// target number must be FREE (#14 decision (1)) — renumber MOVES a chapter to an
// unoccupied number; it does not shift or swap other chapters.

import type { GraphMutation } from "../mutations.js";
import {
  type RecipeCommon,
  K_CHAPTER_NUMBER, K_LESSON_CHAPTER,
  asNum, nodeById, childLessons, chapterNumberOf, usedChapterNumbers,
} from "./shared.js";
import { editStructural, structuralEditErrors } from "./structural-edit.js";

export type RenumberArgs = RecipeCommon & {
  chapterId: string;
  newNumber: number;
};

export const renumber: GraphMutation<RenumberArgs> = {
  name: "renumber",
  describe: (a) => `renumber chapter '${a.chapterId}' to ${a.newNumber}`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const chapter = nodeById(base, a.chapterId);
    if (!chapter) { errors.push(`renumber: chapter '${a.chapterId}' does not exist in the draft.`); return { errors, warnings: [] }; }
    if (chapter.type !== a.profile.chapterKind) { errors.push(`renumber: node '${a.chapterId}' is a '${chapter.type}', not a ${a.profile.chapterKind}.`); return { errors, warnings: [] }; }
    if (asNum(a.newNumber) == null) { errors.push(`renumber: 'newNumber' must be a finite number.`); return { errors, warnings: [] }; }
    const current = chapterNumberOf(chapter, a.profile, a.structuralAliases);
    if (current === a.newNumber) errors.push(`renumber: chapter '${a.chapterId}' already has number ${a.newNumber}.`);
    const used = usedChapterNumbers(base, a.profile, a.structuralAliases, a.chapterId);
    if (used.has(a.newNumber)) errors.push(`renumber: chapter number ${a.newNumber} is already used by '${used.get(a.newNumber)}'. renumber targets a FREE number; moving into an occupied slot (insert-with-shift / swap) is a separate, explicit operation.`);
    // Structural-edit preflight on the chapter itself (safe paths + existing key).
    errors.push(...structuralEditErrors(chapter, a.chapterId, K_CHAPTER_NUMBER, a.structuralAliases));
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    let nodes = editStructural(base.nodes, a.chapterId, K_CHAPTER_NUMBER, a.newNumber, a.structuralAliases);
    // Cascade-rewrite every child lesson's chapter-membership number so the
    // Regime-B join key stays consistent with the renumbered chapter.
    for (const lesson of childLessons(base, a.chapterId, a.profile)) {
      nodes = editStructural(nodes, lesson.id, K_LESSON_CHAPTER, a.newNumber, a.structuralAliases);
    }
    return { nodes, edges: base.edges };
  },
};
