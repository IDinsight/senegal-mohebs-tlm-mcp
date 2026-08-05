// ── Recipe: add_lesson ────────────────────────────────────────────────────────
// Create a lesson node + link it (hasChild) to an EXISTING chapter, as one
// composite. Additive. Chapter membership IS the hasChild edge — no number to set.

import type { GraphMutation } from "../mutations.js";
import { createNode, linkNodes } from "../structural.js";
import {
  type RecipeCommon,
  K_LESSON_POSITION, W_TEXT, W_TEXT_EN,
  nodeById, childLessons, positionOf, buildProps,
} from "./shared.js";

export type AddLessonArgs = RecipeCommon & {
  chapterId: string;
  lessonId: string;       // minted by the tool layer
  text: string;
  text_en?: string;
  order?: number;
  isBilan?: boolean;
};

export const addLesson: GraphMutation<AddLessonArgs> = {
  name: "addLesson",
  describe: (a) => `add a lesson to chapter '${a.chapterId}'`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const chapter = nodeById(base, a.chapterId);
    if (!chapter) errors.push(`add_lesson: chapter '${a.chapterId}' does not exist in the draft.`);
    else if (chapter.type !== a.profile.chapterKind) errors.push(`add_lesson: node '${a.chapterId}' is a '${chapter.type}', not a ${a.profile.chapterKind}.`);
    if (typeof a.text !== "string" || a.text.length === 0) errors.push(`add_lesson: 'text' (the lesson objective) is required.`);
    if (base.nodes.some((n) => n.id === a.lessonId)) errors.push(`add_lesson: minted lesson id '${a.lessonId}' already exists (retry).`);
    return { errors, warnings };
  },
  apply: (base, a) => {
    // apply runs BEFORE validate in the dry-run — guard the missing-chapter
    // case so a bad chapterId yields a clean "blocked" (validate) rather than a
    // throw. A no-op `after` diffs to nothing; validate blocks the token anyway.
    const chapter = nodeById(base, a.chapterId);
    if (!chapter) return base;
    const siblings = childLessons(base, a.chapterId, a.profile);
    const position = a.order ?? (siblings.reduce((m, l) => Math.max(m, positionOf(l, a.profile, a.structuralAliases)), 0) + 1);
    const properties = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT, value: a.text },
        { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT_EN, value: a.text_en },
        { aliases: a.structuralAliases, kind: a.profile.lessonKind, key: K_LESSON_POSITION, value: position },
      ],
      [{ path: a.profile.assessmentProperty, value: a.isBilan ?? false }],
    );
    let g = createNode.apply(base, { kind: a.profile.lessonKind, properties, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.lessonId });
    g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.chapterId, toId: a.lessonId, properties: { orderInParent: position }, namespace: a.namespace });
    return g;
  },
};
