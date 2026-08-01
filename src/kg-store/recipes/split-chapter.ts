// ── Recipe: split_chapter ─────────────────────────────────────────────────────
// Create a new chapter and MOVE the tail lessons (from `atLessonId` onward, in
// presentation order) to it — unlink old hasChild, link new, rewrite each moved
// lesson's chapter-membership number. The new chapter is APPENDED at the next
// free number by default (#14 decision: no shift of existing chapters); pass a
// free `newNumber` to place it in a gap. Within-chapter positions are preserved.

import { edgeId } from "../types.js";
import type { MutationGraph } from "../types.js";
import type { GraphMutation } from "../mutations.js";
import { createNode, linkNodes, unlinkNodes } from "../structural.js";
import {
  type RecipeCommon,
  K_CHAPTER_NUMBER, K_LESSON_CHAPTER, W_TITLE, W_TITLE_EN,
  asNum, readLogical, buildProps,
  nodeById, childLessons, positionOf, usedChapterNumbers, nextChapterNumber,
} from "./shared.js";
import { editStructural } from "./structural-edit.js";

export type SplitChapterArgs = RecipeCommon & {
  chapterId: string;
  atLessonId: string;
  newChapterId: string;    // minted
  newTitle?: string;
  newTitle_en?: string;
  newNumber?: number;
};

// The effective new-chapter number — the shared pure fn both validate and apply
// use so they never disagree (append at max+1 unless a free number is given).
function splitNumber(base: MutationGraph, a: SplitChapterArgs): number {
  return a.newNumber ?? nextChapterNumber(base, a.profile, a.structuralAliases);
}

export const splitChapter: GraphMutation<SplitChapterArgs> = {
  name: "splitChapter",
  describe: (a) => `split chapter '${a.chapterId}' at lesson '${a.atLessonId}' into a new chapter`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const chapter = nodeById(base, a.chapterId);
    if (!chapter) { errors.push(`split_chapter: chapter '${a.chapterId}' does not exist.`); return { errors, warnings: [] }; }
    if (chapter.type !== a.profile.chapterKind) errors.push(`split_chapter: node '${a.chapterId}' is a '${chapter.type}', not a ${a.profile.chapterKind}.`);
    const lessons = childLessons(base, a.chapterId, a.profile).sort((x, y) => positionOf(x, a.profile, a.structuralAliases) - positionOf(y, a.profile, a.structuralAliases));
    const at = lessons.findIndex((l) => l.id === a.atLessonId);
    if (at < 0) errors.push(`split_chapter: lesson '${a.atLessonId}' is not a lesson of chapter '${a.chapterId}'.`);
    if (base.nodes.some((n) => n.id === a.newChapterId)) errors.push(`split_chapter: minted chapter id '${a.newChapterId}' already exists (retry).`);
    if (a.newNumber !== undefined) {
      if (asNum(a.newNumber) == null) errors.push(`split_chapter: 'newNumber' must be a finite number.`);
      else {
        const used = usedChapterNumbers(base, a.profile, a.structuralAliases);
        if (used.has(a.newNumber)) errors.push(`split_chapter: newNumber ${a.newNumber} is already used by '${used.get(a.newNumber)}'. Choose a free number, or omit newNumber to append at the end.`);
      }
    }
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    const source = nodeById(base, a.chapterId);
    if (!source) return base; // apply precedes validate; missing chapter → no-op
    const effNum = splitNumber(base, a);
    const sourceTitle = readLogical(source, a.profile.chapterKind, W_TITLE, a.wordingAliases);
    const newTitle = a.newTitle ?? (typeof sourceTitle === "string" ? `${sourceTitle} (suite)` : "");
    const chapterProps = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE, value: newTitle },
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE_EN, value: a.newTitle_en },
        { aliases: a.structuralAliases, kind: a.profile.chapterKind, key: K_CHAPTER_NUMBER, value: effNum },
      ],
      [],
    );
    let g = createNode.apply(base, { kind: a.profile.chapterKind, properties: chapterProps, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.newChapterId });

    const lessons = childLessons(base, a.chapterId, a.profile).sort((x, y) => positionOf(x, a.profile, a.structuralAliases) - positionOf(y, a.profile, a.structuralAliases));
    const at = lessons.findIndex((l) => l.id === a.atLessonId);
    const tail = at < 0 ? [] : lessons.slice(at);
    tail.forEach((lesson, i) => {
      g = unlinkNodes.apply(g, { edgeId: edgeId(a.profile.containerEdge, a.chapterId, lesson.id) });
      g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.newChapterId, toId: lesson.id, properties: { orderInParent: positionOf(lesson, a.profile, a.structuralAliases) || i + 1 }, namespace: a.namespace });
      // Rewrite ONLY the chapter-membership number — within-chapter positions
      // are preserved (#14 decision (b): renumber only when explicitly asked).
      g = { nodes: editStructural(g.nodes, lesson.id, K_LESSON_CHAPTER, effNum, a.structuralAliases), edges: g.edges };
    });
    return g;
  },
};
