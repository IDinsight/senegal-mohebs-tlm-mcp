// ── Recipe: split_lesson_grouping ─────────────────────────────────────────────────────
// Create a new chapter and MOVE the tail lessons (from `atLessonId` onward, in
// presentation order) to it — unlink old hasChild, link new. Membership is the
// edge, so the moved lessons need no number rewrite. The new chapter is APPENDED
// at the next free number by default (#14 decision: no shift of existing
// chapters); pass a free `newNumber` to place it in a gap. Positions preserved.

import { edgeId } from "../types.js";
import type { MutationGraph } from "../types.js";
import type { GraphMutation } from "../mutations.js";
import { createNode, linkNodes, unlinkNodes } from "../structural.js";
import { readAtPath, writeAtPath } from "../upsert-property.js";
import {
  type RecipeCommon,
  K_CHAPTER_NUMBER, W_TITLE, W_TITLE_EN,
  asNum, readLogical, buildProps,
  nodeById, childLessons, positionOf, usedChapterNumbers, nextChapterNumber,
  resolveStatementType, stampLcProps, lcLabels,
} from "./shared.js";

export type SplitLessonGroupingArgs = RecipeCommon & {
  groupingId: string;
  atLessonId: string;
  newGroupingId: string;    // minted
  newTitle?: string;
  newTitle_en?: string;
  newNumber?: number;
};

// The effective new-chapter number — the shared pure fn both validate and apply
// use so they never disagree (append at max+1 unless a free number is given).
function splitNumber(base: MutationGraph, a: SplitLessonGroupingArgs): number {
  return a.newNumber ?? nextChapterNumber(base, a.profile, a.structuralAliases);
}

export const splitLessonGrouping: GraphMutation<SplitLessonGroupingArgs> = {
  name: "splitLessonGrouping",
  describe: (a) => `split chapter '${a.groupingId}' at lesson '${a.atLessonId}' into a new chapter`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const chapter = nodeById(base, a.groupingId);
    if (!chapter) { errors.push(`split_lesson_grouping: chapter '${a.groupingId}' does not exist.`); return { errors, warnings: [] }; }
    if (chapter.type !== a.profile.chapterKind) errors.push(`split_lesson_grouping: node '${a.groupingId}' is a '${chapter.type}', not a ${a.profile.chapterKind}.`);
    const lessons = childLessons(base, a.groupingId, a.profile).sort((x, y) => positionOf(x, a.profile, a.structuralAliases) - positionOf(y, a.profile, a.structuralAliases));
    const at = lessons.findIndex((l) => l.id === a.atLessonId);
    if (at < 0) errors.push(`split_lesson_grouping: lesson '${a.atLessonId}' is not a lesson of chapter '${a.groupingId}'.`);
    if (base.nodes.some((n) => n.id === a.newGroupingId)) errors.push(`split_lesson_grouping: minted chapter id '${a.newGroupingId}' already exists (retry).`);
    if (a.newNumber !== undefined) {
      if (asNum(a.newNumber) == null) errors.push(`split_lesson_grouping: 'newNumber' must be a finite number.`);
      else {
        const used = usedChapterNumbers(base, a.profile, a.structuralAliases);
        if (used.has(a.newNumber)) errors.push(`split_lesson_grouping: newNumber ${a.newNumber} is already used by '${used.get(a.newNumber)}'. Choose a free number, or omit newNumber to append at the end.`);
      }
    }
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    const source = nodeById(base, a.groupingId);
    if (!source) return base; // apply precedes validate; missing chapter → no-op
    const effNum = splitNumber(base, a);
    const sourceTitle = readLogical(source, a.profile.chapterKind, W_TITLE, a.wordingAliases);
    const newTitle = a.newTitle ?? (typeof sourceTitle === "string" ? `${sourceTitle} (suite)` : "");
    let chapterProps = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE, value: newTitle },
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE_EN, value: a.newTitle_en },
        { aliases: a.structuralAliases, kind: a.profile.chapterKind, key: K_CHAPTER_NUMBER, value: effNum },
      ],
      [],
    );
    // Chapter statement_type default comes from the template; moved lessons below
    // keep their own already-stamped LC fields.
    chapterProps = stampLcProps(chapterProps, a.profile.chapterKind, a.lcNodeTemplate, resolveStatementType(base, null, a.profile.chapterKind, a.lcNodeTemplate, a.profile.containerEdge));
    // The split-off grouping is the same TYPE as its source — inherit group_name
    // (LC's authoritative grouping type) rather than hardcoding "Chapitre".
    const srcGroupName = readAtPath(source.properties, "raw.groupName");
    if (typeof srcGroupName === "string") chapterProps = writeAtPath(chapterProps, "raw.groupName", srcGroupName);
    chapterProps = writeAtPath(chapterProps, "raw.groupLevel", effNum);
    let g = createNode.apply(base, { kind: a.profile.chapterKind, properties: chapterProps, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.newGroupingId, labels: lcLabels(a.profile.chapterKind, a.lcNodeTemplate) });

    const lessons = childLessons(base, a.groupingId, a.profile).sort((x, y) => positionOf(x, a.profile, a.structuralAliases) - positionOf(y, a.profile, a.structuralAliases));
    const at = lessons.findIndex((l) => l.id === a.atLessonId);
    const tail = at < 0 ? [] : lessons.slice(at);
    tail.forEach((lesson, i) => {
      g = unlinkNodes.apply(g, { edgeId: edgeId(a.profile.containerEdge, a.groupingId, lesson.id) });
      g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.newGroupingId, toId: lesson.id, properties: { orderInParent: positionOf(lesson, a.profile, a.structuralAliases) || i + 1 }, namespace: a.namespace });
      // Membership is the new hasChild edge above — positions preserved, no number rewrite.
    });
    return g;
  },
};
