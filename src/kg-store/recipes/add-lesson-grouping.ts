// ── Recipe: add_lesson_grouping ───────────────────────────────────────────────
// Create a lesson grouping (an LC LessonGrouping — the generic container whose
// naming/level varies by publisher: Chapitre, Unité, Module…) in ONE atomic draft
// edit. The `groupName` is the grouping TYPE (LC `groupName`, e.g. "Chapitre");
// `number` is its position in the series (LC `groupLevel`). The number must be
// FREE — append or fill a gap (#14 decision (c)); a colliding number is rejected
// here (inserting BETWEEN existing groupings and shifting the rest is renumber).
//
// Post-split (graph-native-authoring): a grouping is created EMPTY — lessons are
// added afterward via add_lesson, because a lesson must align to an existing
// expectation and a brand-new grouping has none to align to.

import type { GraphMutation } from "../mutations.js";
import { createNode } from "../structural.js";
import { writeAtPath } from "../upsert-property.js";
import {
  type RecipeCommon,
  K_CHAPTER_NUMBER, W_TITLE, W_TITLE_EN,
  asNum, buildProps, usedChapterNumbers,
  resolveStatementType, stampLcProps, lcLabels,
} from "./shared.js";

const DEFAULT_GROUP_NAME = "Chapitre";

export type AddLessonGroupingArgs = RecipeCommon & {
  groupingId: string;                                    // minted (the grouping's id)
  number: number;                                       // → groupLevel / position in the series
  title: string;
  title_en?: string;
  groupName?: string;                                   // grouping TYPE (LC groupName); defaults to "Chapitre"
};

export const addLessonGrouping: GraphMutation<AddLessonGroupingArgs> = {
  name: "addLessonGrouping",
  describe: (a) => `add ${a.groupName ?? DEFAULT_GROUP_NAME} ${a.number} ('${a.title}')`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (asNum(a.number) == null) errors.push(`add_lesson_grouping: 'number' must be a finite number.`);
    else {
      const used = usedChapterNumbers(base, a.profile, a.structuralAliases);
      if (used.has(a.number)) errors.push(`add_lesson_grouping: number ${a.number} is already used by '${used.get(a.number)}'. The additive path needs a FREE number (append or fill a gap); to insert between groupings and shift the rest, use renumber.`);
    }
    if (typeof a.title !== "string" || a.title.length === 0) warnings.push(`add_lesson_grouping: grouping created without a title — set one before publishing.`);
    if (base.nodes.some((n) => n.id === a.groupingId)) errors.push(`add_lesson_grouping: minted id '${a.groupingId}' already exists (retry).`);
    // A grouping is born empty; its lessons are added via add_lesson.
    warnings.push(`add_lesson_grouping: grouping created with no child lessons — add them with add_lesson (each aligned to a standard) before publishing.`);
    return { errors, warnings };
  },
  apply: (base, a) => {
    const groupName = a.groupName ?? DEFAULT_GROUP_NAME;
    let props = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE, value: a.title },
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE_EN, value: a.title_en },
        { aliases: a.structuralAliases, kind: a.profile.chapterKind, key: K_CHAPTER_NUMBER, value: a.number },
      ],
      [],
    );
    props = stampLcProps(props, a.profile.chapterKind, a.lcNodeTemplate, resolveStatementType(base, null, a.profile.chapterKind, a.lcNodeTemplate, a.profile.containerEdge));
    // LC-native grouping type + level (the authoritative type; statement_type is a
    // legacy mirror carried only on the migrated seed groupings).
    props = writeAtPath(props, "raw.groupName", groupName);
    props = writeAtPath(props, "raw.groupLevel", a.number);
    props = writeAtPath(props, "raw.statementType", groupName);
    return createNode.apply(base, { kind: a.profile.chapterKind, properties: props, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.groupingId, labels: lcLabels(a.profile.chapterKind, a.lcNodeTemplate) });
  },
};
