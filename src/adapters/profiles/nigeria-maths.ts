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
import type { SubjectProfile } from "../profile.js";

export const NIGERIA_MATHS_PROFILE: SubjectProfile = {
  id: "nigeria-maths/lc-graph-v2",
  capabilities: { exampleDomainRotation: false },

  // Standards-only dialect: its whole hierarchy lives in `statementType`
  // (Grade/Theme/Sub-Theme/Topic/Performance Objective/Content) — which is exactly
  // where the generic reader takes an SFI's kind from, so nothing extra is
  // declared. The LearningComponent layer is keyed by its label. No ordinal field.
  parse: {},
};

// The authored GRAPH GUIDE for Nigeria maths (phase 2c) — markdown the LLM reads
// to interpret the graph. See docs/design-notes/authorable-catalog.md.
export const NIGERIA_MATHS_GUIDE = `# Nigeria Maths (Primary 1–3) — graph guide

How the Nigeria maths knowledge graph is shaped. This is a **standards-only
reference framework** — the NERDC 9-Year Basic Education Mathematics Curriculum
(an EIDU export). There is no teaching content to author or generate: no \`Lesson\`,
\`Activity\`, or \`Material\`, and no deliverables. You browse and align against it;
you do not author lessons into it.

## The hierarchy

A single \`StandardsFramework\` root, then a pure \`hasChild\` tree of
\`StandardsFrameworkItem\`s whose **kind is their level** (their \`statementType\`):

\`\`\`
Grade (PRIMARY ONE / TWO / THREE)
  └─ Theme            ("EVERY DAY STATISTICS", "ALGEBRAIC PROCESSES", …)
       └─ Sub-Theme   ("Data Collection and Presentation", …)
            └─ Topic   ("Data Collection", "Open Sentences", …)
                 ├─ Content               (the curriculum content statement)
                 └─ Performance Objective (what a pupil should be able to do)
\`\`\`

\`Content\` and \`Performance Objective\` are the leaves. A \`LearningComponent\`
\`supports\` a \`Performance Objective\` or a \`Content\` — the fine-grained skills EIDU
attaches beneath the objectives.

## Only two edge types

- \`hasChild\` — the containment tree above (Grade → … → Content / Performance Objective).
- \`supports\` — a \`LearningComponent\` to the SFI it elaborates.

There is **no** \`hasPart\`, no \`hasEducationalAlignment\`, and no ordinal field —
sequence is traversal order, not a \`position\`.

## Conventions

- **Kinds are the graph's own words** — an SFI's level is its \`statementType\`
  (\`Grade\`/\`Theme\`/\`Sub-Theme\`/\`Topic\`/\`Content\`/\`Performance Objective\`); the
  fine-grained skills are \`LearningComponent\`s by label.
- **No content authoring, no coverage.** This framework exists to be browsed and
  aligned against, not to hold generated materials — a reference framework has
  nothing to "complete", so there are no coverage expectations.
`;
