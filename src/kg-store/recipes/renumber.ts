// ── Recipe: renumber ──────────────────────────────────────────────────────────
// Structural-property edit of a chapter's number: rewrites the chapter's `number`
// (order + raw.metadata.order). Lessons are NOT touched — chapter→lesson is the
// hasChild edge, so a renumbered chapter keeps its lessons with no cascade. The
// target number must be FREE (#14 decision (1)) — renumber MOVES a chapter to an
// unoccupied number; it does not shift or swap other chapters.

import type { GraphMutation } from "../mutations.js";
import {
  type RecipeCommon,
  K_CHAPTER_NUMBER,
  asNum, nodeById, chapterNumberOf, usedChapterNumbers,
} from "./shared.js";
import { editStructural, structuralEditErrors } from "./structural-edit.js";

export type RenumberArgs = RecipeCommon & {
  groupingId: string;
  newNumber: number;
};

export const renumber: GraphMutation<RenumberArgs> = {
  name: "renumber",
  describe: (a) => `renumber chapter '${a.groupingId}' to ${a.newNumber}`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const chapter = nodeById(base, a.groupingId);
    if (!chapter) { errors.push(`renumber: chapter '${a.groupingId}' does not exist in the draft.`); return { errors, warnings: [] }; }
    if (chapter.type !== a.profile.chapterKind) { errors.push(`renumber: node '${a.groupingId}' is a '${chapter.type}', not a ${a.profile.chapterKind}.`); return { errors, warnings: [] }; }
    if (asNum(a.newNumber) == null) { errors.push(`renumber: 'newNumber' must be a finite number.`); return { errors, warnings: [] }; }
    const current = chapterNumberOf(chapter, a.profile, a.structuralAliases);
    if (current === a.newNumber) errors.push(`renumber: chapter '${a.groupingId}' already has number ${a.newNumber}.`);
    const used = usedChapterNumbers(base, a.profile, a.structuralAliases, a.groupingId);
    if (used.has(a.newNumber)) errors.push(`renumber: chapter number ${a.newNumber} is already used by '${used.get(a.newNumber)}'. renumber targets a FREE number; moving into an occupied slot (insert-with-shift / swap) is a separate, explicit operation.`);
    // Structural-edit preflight on the chapter itself (safe paths + existing key).
    errors.push(...structuralEditErrors(chapter, a.groupingId, K_CHAPTER_NUMBER, a.structuralAliases));
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    // Only the chapter's own number changes; lessons follow via the hasChild edge.
    const nodes = editStructural(base.nodes, a.groupingId, K_CHAPTER_NUMBER, a.newNumber, a.structuralAliases);
    return { nodes, edges: base.edges };
  },
};
