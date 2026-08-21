/*
 * Subject profile: Madhi maths, Class 1–5 (data, not behavior).
 *
 * A primary-maths standards framework in the Indian NEP/NCF idiom (an EIDU/LC
 * export). Standards-only (no Lesson/Activity/Material, nothing to generate); it
 * exists to be browsed and aligned against. Its hierarchy lives entirely in
 * `statementType` (Curricular Goal/Competency/Content) — where the generic reader
 * takes an SFI's kind from — so nothing extra is declared. No ordinal field →
 * `numberFrom` omitted; sequence comes from traversal order.
 */
import type { SubjectProfile } from "../../profile.js";

export const MADHI_MATHS_PROFILE: SubjectProfile = {
  id: "madhi-maths/lc-graph-v1",
  capabilities: { exampleDomainRotation: false },

  // Standards-only dialect: hierarchy carried by `statementType`, LearningComponent
  // layer keyed by its label. No ordinal field.
  parse: {},
};

// The authored GRAPH GUIDE for this subject ships as DATA, not a literal here:
// assets/madhi/class-1-5/maths/GRAPH_GUIDE.md, read at seed time by
// getRegisteredGuide (adapters/index.ts). See docs/design-notes/authorable-catalog.md.
