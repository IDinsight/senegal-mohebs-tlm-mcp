// ── Recipe: add_lesson ────────────────────────────────────────────────────────
// Create a content lesson node, link it (hasChild) to an EXISTING chapter, AND
// align it (alignmentEdge, e.g. supports) to an EXISTING spine expectation (the
// objectif spécifique it teaches) — one atomic composite. Additive. Chapter
// membership and expectation alignment are both edges; there is no number join.
//
// Post-split (graph-native-authoring): the objective lives on the expectation,
// not the lesson, so a lesson MUST align to a standard that already exists — the
// standard is authored separately, upstream of teaching material.

import type { GraphMutation } from "../mutations.js";
import { createNode, linkNodes } from "../structural.js";
import { writeAtPath } from "../upsert-property.js";
import {
  type RecipeCommon,
  K_LESSON_POSITION, W_TEXT, W_TEXT_EN,
  nodeById, childLessons, positionOf, buildProps,
  stampLcProps, lcLabels,
} from "./shared.js";

export type AddLessonArgs = RecipeCommon & {
  groupingId: string;
  expectationId: string;  // the existing spine standard (OS) this lesson aligns to
  lessonId: string;       // minted by the tool layer
  text: string;           // the lesson's own title/name (NOT the OS — that's on the expectation)
  text_en?: string;
  order?: number;
  isBilan?: boolean;
};

export const addLesson: GraphMutation<AddLessonArgs> = {
  name: "addLesson",
  describe: (a) => `add a lesson to chapter '${a.groupingId}' (aligned to '${a.expectationId}')`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const chapter = nodeById(base, a.groupingId);
    if (!chapter) errors.push(`add_lesson: chapter '${a.groupingId}' does not exist in the draft.`);
    else if (chapter.type !== a.profile.chapterKind) errors.push(`add_lesson: node '${a.groupingId}' is a '${chapter.type}', not a ${a.profile.chapterKind}.`);
    const expKind = a.profile.expectationKind;
    if (expKind) {
      const expectation = nodeById(base, a.expectationId);
      if (!expectation) errors.push(`add_lesson: expectation '${a.expectationId}' does not exist in the draft — a lesson must align to a standard that already exists.`);
      else if (expectation.type !== expKind) errors.push(`add_lesson: node '${a.expectationId}' is a '${expectation.type}', not a ${expKind}.`);
    }
    if (typeof a.text !== "string" || a.text.length === 0) errors.push(`add_lesson: 'text' (the lesson title) is required.`);
    if (base.nodes.some((n) => n.id === a.lessonId)) errors.push(`add_lesson: minted lesson id '${a.lessonId}' already exists (retry).`);
    return { errors, warnings };
  },
  apply: (base, a) => {
    // apply runs BEFORE validate in the dry-run — guard the missing-endpoint
    // cases so a bad id yields a clean "blocked" (validate) rather than a throw.
    const chapter = nodeById(base, a.groupingId);
    const expKind = a.profile.expectationKind;
    if (!chapter || (expKind && !nodeById(base, a.expectationId))) return base;
    const siblings = childLessons(base, a.groupingId, a.profile);
    const position = a.order ?? (siblings.reduce((m, l) => Math.max(m, positionOf(l, a.profile, a.structuralAliases)), 0) + 1);
    let properties = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT, value: a.text },
        { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT_EN, value: a.text_en },
        { aliases: a.structuralAliases, kind: a.profile.lessonKind, key: K_LESSON_POSITION, value: position },
      ],
      [{ path: a.profile.assessmentProperty, value: a.isBilan ?? false }],
    );
    // Stamp LC identity (labels/normalized_type) — a content Lesson carries no
    // objective/strand of its own; those live on the aligned expectation.
    properties = stampLcProps(properties, a.profile.lessonKind, a.lcNodeTemplate, null);
    // Bilan as data: the explicit `raw.educational_use` is what the parser reads
    // on re-hydration (the top-level assessment flag above is for draft-time
    // coverage, before the graph is re-parsed).
    properties = writeAtPath(properties, "raw.educationalUse", a.isBilan ? "Assessment" : "Instruction");
    let g = createNode.apply(base, { kind: a.profile.lessonKind, properties, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.lessonId, labels: lcLabels(a.profile.lessonKind, a.lcNodeTemplate) });
    g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.groupingId, toId: a.lessonId, properties: { orderInParent: position }, namespace: a.namespace });
    // Align the lesson to the standard it teaches (coverage edge).
    if (expKind && a.profile.alignmentEdge) {
      g = linkNodes.apply(g, { edgeType: a.profile.alignmentEdge, fromId: a.lessonId, toId: a.expectationId, properties: {}, namespace: a.namespace });
    }
    return g;
  },
};
