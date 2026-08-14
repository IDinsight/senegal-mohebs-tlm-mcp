/*
 * Subject profile: CI maths (data, not behavior).
 *
 * The converged `{ nodes, relationships }` LC envelope. Two axes read through
 * edges — schedule (week→OS) and content (chapter→lesson→OS). A `chapter` is a
 * content LessonGrouping; a `lesson` is a content Lesson aligned to its spine
 * `expectation` (the objectif spécifique). The bilan is canonical data
 * (educationalUse "Assessment" → isAssessment in parseGraph), surfaced by the
 * exactly-one-assessment-child coverage rule below. See
 * docs/design-notes/graph-native-authoring.md.
 */
import type { SubjectProfile } from "../profile.js";

export const CI_MATHS_PROFILE: SubjectProfile = {
  id: "ci-maths/nodes-relationships-v1",
  capabilities: { exampleDomainRotation: true, characterConsistency: true },

  // Kinds come straight from the graph's canonical fields: a chapter is a
  // LessonGrouping named `Chapitre`, a week one named `Semaine`; a lesson is a
  // `Lesson`, a standard a `Standard` (its normalizedStatementType). No role table.
  parse: {
    numberFrom: "order",
    // Chapter progression is the canonical content prerequisite (read reversed
    // into buildsTowards/buildsFrom).
    dependencyEdge: "hasDependency",
  },

  // Teacher guide filenames contain "fiche(s) de leçon"; the pupil manual is the
  // default (everything else). Mutually exclusive → each file is exactly one.
  deliverables: [
    { key: "manual", label: "Manuel de l'élève (pupil book)", scopeKind: "Chapitre", match: "default", dependsOn: [], promptFile: "PROMPT_generate_chapter.md" },
    { key: "lessons", label: "Fiches de leçons (teacher guide)", scopeKind: "Chapitre", match: { filenameContainsAny: ["fiches de leçons", "fiche de leçon"] }, dependsOn: ["manual"], promptFile: "PROMPT_generate_lessons.md" },
  ],

  // NOTE: multi-parent is deliberately NOT used for lessons — a lesson
  // legitimately has two parents (its week on the schedule axis, its chapter on
  // the content axis). single-content-parent counts only the CHAPTER parents
  // (via hasPart), so >1 is the genuine ambiguity.
  coverage: [
    { rule: "empty-container", kinds: ["Chapitre"] },
    { rule: "single-content-parent", childKind: "Lesson", parentKind: "Chapitre", containment: "hasPart" },
    { rule: "exactly-one-assessment-child", parentKind: "Chapitre", childKind: "Lesson", containment: "hasPart", noun: "bilan" },
  ],
};
