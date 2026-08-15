/*
 * Subject profile: CE1 reading (data, not behavior).
 *
 * A "unit" is a WEEK (semaine). Each week is a content `LessonGrouping` holding
 * Jour 1–5 `day` groupings, each holding that day's session `Lesson`s, which
 * align to the spine `expectation` they teach. The parse keeps only that content
 * spine + its standards/components + the content layer (the content-reachable
 * prune); everything else is dropped to keep the store lean. See
 * docs/design-notes/graph-native-authoring.md (Scope B/C).
 */
import type { SubjectProfile } from "../profile.js";

export const CE1_READING_PROFILE: SubjectProfile = {
  id: "ce1-reading/nodes-relationships-v1",
  capabilities: { exampleDomainRotation: false },

  // Kinds are canonical: a week is a LessonGrouping named `Semaine`, a day one
  // named `Jour`; sessions are `Lesson`s and standards are `Standard`s. No role table.
  parse: {
    numberFrom: "position", // canonical LC: week/day number is the grouping's `position`
    prune: { strategy: "content-reachable-from-roots", rootKinds: ["Semaine"] },
  },

  deliverables: [
    { key: "teacher_guide", label: "Guide de l'enseignant·e (teacher guide)", scopeKind: "Semaine", match: "default", dependsOn: [], promptFile: "PROMPT_generate_lessons.md" },
  ],

  // Subject-neutral shapes only. A reading session/component has exactly one
  // parent (unlike a maths lesson, which has a week axis too), so multi-parent applies.
  coverage: [
    { rule: "empty-container", kinds: ["Semaine", "Jour"] },
    { rule: "multi-parent", childKinds: ["Lesson", "LearningComponent"] },
  ],
};
