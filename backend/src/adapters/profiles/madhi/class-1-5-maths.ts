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

// The authored GRAPH GUIDE for Madhi maths (phase 2c) — markdown the LLM reads
// to interpret the graph. See docs/design-notes/authorable-catalog.md.
export const MADHI_MATHS_GUIDE = `# Madhi Maths (Class 1–5) — graph guide

How the Madhi maths knowledge graph is shaped. This is a **standards-only
reference framework** in the Indian NEP/NCF idiom (an EIDU export). There is no
teaching content to author or generate: no \`Lesson\`, \`Activity\`, or \`Material\`,
and no deliverables. You browse and align against it; you do not author lessons
into it.

## The hierarchy

A single \`StandardsFramework\` root, then a pure \`hasChild\` tree of
\`StandardsFrameworkItem\`s whose **kind is their level** (their \`statementType\`):

\`\`\`
Curricular Goal        (a broad aim pupils work towards)
  └─ Competency        (a capability that realizes the goal)
       └─ Content       (the finest learning-outcome/content leaf)
\`\`\`

\`Content\` is the finest standards leaf. A \`LearningComponent\` \`supports\` a
\`Competency\` or a \`Content\` item — the fine-grained skills EIDU attaches beneath
the standards.

## Only two edge types

- \`hasChild\` — the containment tree above (Curricular Goal → Competency → Content).
- \`supports\` — a \`LearningComponent\` to the SFI it elaborates.

There is **no** \`hasPart\`, no \`hasEducationalAlignment\`, and no ordinal field —
sequence is traversal order, not a \`position\`.

## Conventions

- **Kinds are the graph's own words** — an SFI's level is its \`statementType\`
  (\`Curricular Goal\`/\`Competency\`/\`Content\`); the fine-grained skills are
  \`LearningComponent\`s by label.
- **No content authoring, no coverage.** This framework exists to be browsed and
  aligned against, not to hold generated materials — nothing to "complete", so no
  coverage expectations.
- **Deleting is bulk and cascades.** \`delete_nodes\` / \`delete_edges\` each take an
  ARRAY (one atomic draft edit, all-or-nothing). \`delete_nodes\` cascades along
  \`hasChild\`: removing an SFI takes its descendants and their incident
  \`supports\`/\`hasChild\` edges. The dry-run WARNS with the full set before you
  confirm (no force flag).
`;
