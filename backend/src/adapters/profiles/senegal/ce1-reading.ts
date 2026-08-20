/*
 * Subject profile: CE1 reading (data, not behavior).
 *
 * A "unit" is a WEEK (semaine). Each week is a content `LessonGrouping` holding
 * Jour 1–5 day `Lesson`s, each holding that day's session `Activity`s, which
 * align to the spine `expectation` they teach (canonical LC content nesting:
 * LessonGrouping → Lesson → Activity). The parse keeps only that content spine +
 * its standards/components + the content layer (the content-reachable prune);
 * everything else is dropped to keep the store lean. See
 * docs/design-notes/graph-native-authoring.md (Scope B/C).
 *
 * The authored GRAPH GUIDE for this subject is NOT a literal here — it lives as
 * data at assets/senegal/ce1/reading/GRAPH_GUIDE.md, read at seed time by
 * getRegisteredGuide (adapters/index.ts). Keeping the long markdown out of this
 * module leaves it a small, typed `core`. See docs/design-notes/authorable-catalog.md.
 */
import type { SubjectProfile } from "../../profile.js";

export const CE1_READING_PROFILE: SubjectProfile = {
  id: "ce1-reading/nodes-relationships-v1",
  capabilities: { exampleDomainRotation: false },

  // Kinds are canonical: a week is a LessonGrouping named `Semaine`, a day is a
  // `Lesson`, a session is an `Activity`, and standards are `Standard`s. No role
  // table. The ordinal (week/day number, session order) is the canonical LC
  // `position`, so the ordinal source is "position".
  parse: {
    numberFrom: "position",
    prune: { strategy: "content-reachable-from-roots", rootKinds: ["Course", "Semaine"] },
  },
};
