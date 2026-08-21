/*
 * Subject profile: Ghana maths, Basic 4–6 (data, not behavior).
 *
 * The Ghana NaCCA "Basic School Curriculum — Mathematics" (an EIDU/LC export).
 * A standards-only graph (no Lesson/Activity/Material, nothing to generate); it
 * exists to be browsed and aligned against. Its hierarchy lives entirely in
 * `statementType` (Grade/Strand/Sub-Strand/Content Standard/Indicator) — the same
 * NaCCA shape as Ghana English, one grade band up. No ordinal field →
 * `numberFrom` omitted; sequence comes from traversal order.
 */
import type { SubjectProfile } from "../../profile.js";

export const GHANA_MATHS_PROFILE: SubjectProfile = {
  id: "ghana-maths/lc-graph-v1",
  capabilities: { exampleDomainRotation: false },

  // Standards-only dialect: hierarchy carried by `statementType`, LearningComponent
  // layer keyed by its label. No ordinal field.
  parse: {},
};

// The authored GRAPH GUIDE for this subject ships as DATA, not a literal here:
// assets/ghana/basic-4-6/maths/GRAPH_GUIDE.md, read at seed time by
// getRegisteredGuide (adapters/index.ts). See docs/design-notes/authorable-catalog.md.
