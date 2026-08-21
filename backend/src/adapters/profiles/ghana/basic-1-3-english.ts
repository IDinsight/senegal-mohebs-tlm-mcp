/*
 * Subject profile: Ghana English, Basic 1–3 (data, not behavior).
 *
 * The Ghana NaCCA "Basic School Curriculum — English Language" (an EIDU/LC
 * export). Like the other EIDU imports this is a standards-only graph (no
 * Lesson/Activity/Material, nothing to generate); it exists to be browsed and
 * aligned against. Its hierarchy lives entirely in `statementType`
 * (Grade/Strand/Sub-Strand/Content Standard/Indicator) — where the generic reader
 * takes an SFI's kind from — so nothing extra is declared. No ordinal field →
 * `numberFrom` omitted; sequence comes from traversal order.
 */
import type { SubjectProfile } from "../../profile.js";

export const GHANA_ENGLISH_PROFILE: SubjectProfile = {
  id: "ghana-english/lc-graph-v1",
  capabilities: { exampleDomainRotation: false },

  // Standards-only dialect: hierarchy carried by `statementType`, LearningComponent
  // layer keyed by its label. No ordinal field.
  parse: {},
};

// The authored GRAPH GUIDE for this subject ships as DATA, not a literal here:
// assets/ghana/basic-1-3/english/GRAPH_GUIDE.md, read at seed time by
// getRegisteredGuide (adapters/index.ts). See docs/design-notes/authorable-catalog.md.
