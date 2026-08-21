/*
 * Subject profile: CBSE science, Class 9–10 (data, not behavior).
 *
 * The "Learning Framework — Science" published by the Central Board of Secondary
 * Education (CBSE) with Azim Premji University — an EIDU/LC export. Like Nigeria
 * maths this is a standards-only graph (no Lesson/Activity/Material, nothing to
 * generate); it exists to be browsed and aligned against. Its whole hierarchy
 * lives in `statementType` (Class/Content Domain/Chapter/NCERT Learning Outcome/
 * Content Domain Specific Learning Outcome/Indicator) — exactly where the generic
 * reader takes an SFI's kind from — so nothing extra is declared. There is no
 * ordinal field → `numberFrom` omitted; sequence comes from traversal order. No
 * deliverables or coverage — a reference framework has nothing to complete.
 */
import type { SubjectProfile } from "../../profile.js";

export const CBSE_SCIENCE_PROFILE: SubjectProfile = {
  id: "cbse-science/lc-graph-v1",
  capabilities: { exampleDomainRotation: false },

  // Standards-only dialect: the hierarchy is carried by `statementType`, and the
  // LearningComponent layer is keyed by its label. No ordinal field.
  parse: {},
};

// The authored GRAPH GUIDE for this subject ships as DATA, not a literal here:
// assets/cbse/class-9-10/science/GRAPH_GUIDE.md, read at seed time by
// getRegisteredGuide (adapters/index.ts). See docs/design-notes/authorable-catalog.md.
