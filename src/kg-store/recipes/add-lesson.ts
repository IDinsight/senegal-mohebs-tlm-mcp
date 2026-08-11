// ── Recipe: add_lesson ────────────────────────────────────────────────────────
// Create a lesson node + link it (hasChild) to an EXISTING chapter, as one
// composite. Additive. Chapter membership IS the hasChild edge — no number to set.

import type { GraphMutation } from "../mutations.js";
import { createNode, linkNodes } from "../structural.js";
import {
  type RecipeCommon,
  K_LESSON_POSITION, W_TEXT, W_TEXT_EN,
  nodeById, childLessons, positionOf, buildProps,
  resolveStatementType, stampLcProps, lcLabels,
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
    // Faithful-LC warning: the lesson's strand (statement_type) is inherited
    // from its domaine ancestor. If that can't be resolved (chapter not yet
    // under a domaine, no sibling to copy), the node lands without a strand —
    // surface it so the reviewer fills it before publish.
    if (chapter && chapter.type === a.profile.chapterKind
        && a.lcNodeTemplate?.[a.profile.lessonKind]?.statementType != null
        && resolveStatementType(base, a.chapterId, a.profile.lessonKind, a.lcNodeTemplate, a.profile.containerEdge) == null) {
      warnings.push(`add_lesson: could not derive the lesson's strand (statement_type) from a domaine ancestor — set it via upsert_property before publishing.`);
    }
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
    let properties = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT, value: a.text },
        { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT_EN, value: a.text_en },
        { aliases: a.structuralAliases, kind: a.profile.lessonKind, key: K_LESSON_POSITION, value: position },
      ],
      [{ path: a.profile.assessmentProperty, value: a.isBilan ?? false }],
    );
    // Stamp LC identity: role/normalized_statement_type from the template, and
    // the strand (statement_type) inherited from the chapter's domaine ancestor.
    const strand = resolveStatementType(base, a.chapterId, a.profile.lessonKind, a.lcNodeTemplate, a.profile.containerEdge);
    properties = stampLcProps(properties, a.profile.lessonKind, a.lcNodeTemplate, strand);
    let g = createNode.apply(base, { kind: a.profile.lessonKind, properties, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.lessonId, labels: lcLabels(a.profile.lessonKind, a.lcNodeTemplate) });
    g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.chapterId, toId: a.lessonId, properties: { orderInParent: position }, namespace: a.namespace });
    return g;
  },
};
