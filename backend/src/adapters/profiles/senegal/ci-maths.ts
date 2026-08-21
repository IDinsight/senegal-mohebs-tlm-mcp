/*
 * Subject profile: CI maths (data, not behavior).
 *
 * The converged `{ nodes, relationships }` LC envelope. Two axes read through
 * edges — schedule (week→OS) and content (chapter→lesson→OS). A `chapter` is a
 * content LessonGrouping; a `lesson` is a content Lesson aligned to its spine
 * `expectation` (the objectif spécifique). The bilan is canonical data
 * (educationalUse "Assessment" → isAssessment in parseGraph); the coded coverage
 * rules were retired in phase 2c, so expectations live in the guide's prose. See
 * docs/design-notes/graph-native-authoring.md.
 */
import type { SubjectProfile } from "../../profile.js";

export const CI_MATHS_PROFILE: SubjectProfile = {
  id: "ci-maths/nodes-relationships-v1",
  capabilities: { exampleDomainRotation: true },

  // Kinds come straight from the graph's canonical fields: a chapter is a
  // LessonGrouping named `Chapitre`, a week one named `Semaine`; a lesson is a
  // `Lesson`, a standard a `Standard` (its normalizedStatementType). No role table.
  parse: {
    // The maths standards spine carries its ordinal in metadata.order (its SFIs
    // have no `position`), so the ordinal source is "order".
    numberFrom: "order",
    // Chapter progression is the canonical content prerequisite (read reversed
    // into buildsTowards/buildsFrom).
    dependencyEdge: "hasDependency",
  },
};

// The authored GRAPH GUIDE for this subject ships as DATA, not a literal here:
// assets/senegal/ci/maths/GRAPH_GUIDE.md, read at seed time by
// getRegisteredGuide (adapters/index.ts). See docs/design-notes/authorable-catalog.md.
