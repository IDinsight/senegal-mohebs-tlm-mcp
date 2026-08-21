/*
 * Subject profile: Rwanda maths, Primary 1–3 (data, not behavior).
 *
 * The Rwanda REB Competence-Based Curriculum (CBC) for primary maths (an EIDU/LC
 * export). Standards-only (no Lesson/Activity/Material, nothing to generate); it
 * exists to be browsed and aligned against. Its hierarchy lives entirely in
 * `statementType` (the CBC's Topic Area / Sub-Topic Area / Unit / objectives
 * ladder) — where the generic reader takes an SFI's kind from — so nothing extra
 * is declared. No ordinal field → `numberFrom` omitted; sequence comes from
 * traversal order.
 *
 * NB: shares the `primary-1-3/maths` grade/subject with Nigeria maths, which is
 * exactly why the adapter registry is keyed by WORKSPACE too — the two are
 * distinct `rwanda/…` vs `nigeria/…` entries.
 */
import type { SubjectProfile } from "../../profile.js";

export const RWANDA_MATHS_PROFILE: SubjectProfile = {
  id: "rwanda-maths/lc-graph-v1",
  capabilities: { exampleDomainRotation: false },

  // Standards-only dialect: hierarchy carried by `statementType`, LearningComponent
  // layer keyed by its label. No ordinal field.
  parse: {},
};

// The authored GRAPH GUIDE for this subject ships as DATA, not a literal here:
// assets/rwanda/primary-1-3/maths/GRAPH_GUIDE.md, read at seed time by
// getRegisteredGuide (adapters/index.ts). See docs/design-notes/authorable-catalog.md.
