// ── Recipe: move_lesson ───────────────────────────────────────────────────────
// Unlink a lesson from its current chapter, link it (hasChild) to another, and
// rewrite its chapter-membership number so it renders under the new chapter.
// Numbers are preserved (#14 decision (b)): the lesson's within-chapter position
// defaults to appending at the tail of the target; pass `position` to place it.

import { edgeId } from "../types.js";
import type { MutationGraph } from "../types.js";
import type { GraphMutation } from "../mutations.js";
import { linkNodes, unlinkNodes } from "../structural.js";
import {
  type RecipeCommon,
  K_CHAPTER_NUMBER, K_LESSON_CHAPTER, K_LESSON_POSITION,
  nodeById, childLessons, chapterParentEdgeIds, chapterNumberOf, positionOf,
} from "./shared.js";
import { editStructural } from "./structural-edit.js";

export type MoveLessonArgs = RecipeCommon & {
  lessonId: string;
  toChapterId: string;
  position?: number;
};

export const moveLesson: GraphMutation<MoveLessonArgs> = {
  name: "moveLesson",
  describe: (a) => `move lesson '${a.lessonId}' to chapter '${a.toChapterId}'`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const lesson = nodeById(base, a.lessonId);
    const toChapter = nodeById(base, a.toChapterId);
    if (!lesson) errors.push(`move_lesson: lesson '${a.lessonId}' does not exist in the draft.`);
    else if (lesson.type !== a.profile.lessonKind) errors.push(`move_lesson: node '${a.lessonId}' is a '${lesson.type}', not a ${a.profile.lessonKind}.`);
    if (!toChapter) errors.push(`move_lesson: target chapter '${a.toChapterId}' does not exist in the draft.`);
    else if (toChapter.type !== a.profile.chapterKind) errors.push(`move_lesson: target '${a.toChapterId}' is a '${toChapter.type}', not a ${a.profile.chapterKind}.`);
    else if (chapterNumberOf(toChapter, a.profile, a.structuralAliases) == null) errors.push(`move_lesson: target chapter '${a.toChapterId}' has no numeric ${K_CHAPTER_NUMBER}.`);
    if (lesson && toChapter) {
      const parents = chapterParentEdgeIds(base, a.lessonId, a.profile);
      if (parents.length === 0) errors.push(`move_lesson: lesson '${a.lessonId}' is not linked to any chapter — nothing to move.`);
      if (parents.includes(edgeId(a.profile.containerEdge, a.toChapterId, a.lessonId))) errors.push(`move_lesson: lesson '${a.lessonId}' is already in chapter '${a.toChapterId}'.`);
    }
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    // apply precedes validate; a missing lesson/target must not throw here.
    const lesson = nodeById(base, a.lessonId);
    const toChapter = nodeById(base, a.toChapterId);
    if (!lesson || !toChapter) return base;
    let g: MutationGraph = base;
    // Detach from every current chapter parent (normally one; more than one is
    // the multi-parent state #13 warns on — moving cleans it up as a side effect).
    for (const id of chapterParentEdgeIds(g, a.lessonId, a.profile)) g = unlinkNodes.apply(g, { edgeId: id });
    const num = chapterNumberOf(toChapter, a.profile, a.structuralAliases) ?? 0;
    const siblings = childLessons(g, a.toChapterId, a.profile);
    const position = a.position ?? (siblings.reduce((m, l) => Math.max(m, positionOf(l, a.profile, a.structuralAliases)), 0) + 1);
    g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.toChapterId, toId: a.lessonId, properties: { orderInParent: position }, namespace: a.namespace });
    // Rewrite the moved lesson: chapter-membership number (mandatory, Regime-B)
    // + within-chapter position.
    g = { nodes: editStructural(g.nodes, a.lessonId, K_LESSON_CHAPTER, num, a.structuralAliases), edges: g.edges };
    g = { nodes: editStructural(g.nodes, a.lessonId, K_LESSON_POSITION, position, a.structuralAliases), edges: g.edges };
    return g;
  },
};
