/*
 * Subject profile: Nigeria maths, Primary 1–3 (data, not behavior).
 *
 * The NERDC "9-Year Basic Education Mathematics Curriculum" — an EIDU/LC export.
 * A standards-only graph (no Lesson/Activity/Material, nothing to generate); it
 * exists to be browsed. This LC dialect carries no `metadata.role` sidecar and a
 * single StandardsFrameworkItem label, so levels are distinguished by
 * `statementType` (Grade/Theme/Sub-Theme/Topic/Performance Objective/Content).
 * There is no ordinal field → `numberFrom` omitted; sequence comes from
 * traversal order. No deliverables or coverage — a reference framework has
 * nothing to complete.
 */
import type { SubjectProfile } from "../../profile.js";

export const NIGERIA_MATHS_PROFILE: SubjectProfile = {
  id: "nigeria-maths/lc-graph-v2",
  capabilities: { exampleDomainRotation: false },

  // Standards-only dialect: its whole hierarchy lives in `statementType`
  // (Grade/Theme/Sub-Theme/Topic/Performance Objective/Content) — which is exactly
  // where the generic reader takes an SFI's kind from, so nothing extra is
  // declared. The LearningComponent layer is keyed by its label. No ordinal field.
  parse: {},
};

// The authored GRAPH GUIDE for this subject ships as DATA, not a literal here:
// assets/nigeria/primary-1-3/maths/GRAPH_GUIDE.md, read at seed time by
// getRegisteredGuide (adapters/index.ts). See docs/design-notes/authorable-catalog.md.
