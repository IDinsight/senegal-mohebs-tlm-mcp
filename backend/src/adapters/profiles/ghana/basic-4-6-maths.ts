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

// The authored GRAPH GUIDE for Ghana maths (phase 2c) — markdown the LLM reads
// to interpret the graph. See docs/design-notes/authorable-catalog.md.
export const GHANA_MATHS_GUIDE = `# Ghana Maths (Basic 4–6) — graph guide

How the Ghana maths knowledge graph is shaped. This is a **standards-only
reference framework** — the NaCCA Basic School Curriculum for Mathematics (an EIDU
export). There is no teaching content to author or generate: no \`Lesson\`,
\`Activity\`, or \`Material\`, and no deliverables. You browse and align against it;
you do not author lessons into it.

## The hierarchy

A single \`StandardsFramework\` root, then a pure \`hasChild\` tree of
\`StandardsFrameworkItem\`s whose **kind is their level** (their \`statementType\`):

\`\`\`
Grade (Basic 4 / Basic 5 / Basic 6)
  └─ Strand              (a broad maths domain, e.g. Number)
       └─ Sub-Strand     (a sub-domain within the strand)
            └─ Content Standard          (what pupils should attain)
                 └─ Indicator            (an observable pupil-level indicator)
\`\`\`

\`Indicator\` is the finest standards leaf. A \`LearningComponent\` \`supports\` a
\`Content Standard\` or an \`Indicator\` — the fine-grained skills EIDU attaches
beneath the standards.

## Only two edge types

- \`hasChild\` — the containment tree above (Grade → … → Indicator).
- \`supports\` — a \`LearningComponent\` to the SFI it elaborates.

There is **no** \`hasPart\`, no \`hasEducationalAlignment\`, and no ordinal field —
sequence is traversal order, not a \`position\`.

## Conventions

- **Kinds are the graph's own words** — an SFI's level is its \`statementType\`
  (\`Grade\`/\`Strand\`/\`Sub-Strand\`/\`Content Standard\`/\`Indicator\`); the fine-grained
  skills are \`LearningComponent\`s by label.
- **No content authoring, no coverage.** This framework exists to be browsed and
  aligned against, not to hold generated materials — nothing to "complete", so no
  coverage expectations.
- **Deleting is bulk and cascades.** \`delete_nodes\` / \`delete_edges\` each take an
  ARRAY (one atomic draft edit, all-or-nothing). \`delete_nodes\` cascades along
  \`hasChild\`: removing an SFI takes its descendants and their incident
  \`supports\`/\`hasChild\` edges. The dry-run WARNS with the full set before you
  confirm (no force flag).
`;
