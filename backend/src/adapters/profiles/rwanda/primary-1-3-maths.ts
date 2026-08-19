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

// The authored GRAPH GUIDE for Rwanda maths (phase 2c) — markdown the LLM reads
// to interpret the graph. See docs/design-notes/authorable-catalog.md.
export const RWANDA_MATHS_GUIDE = `# Rwanda Maths (Primary 1–3) — graph guide

How the Rwanda maths knowledge graph is shaped. This is a **standards-only
reference framework** — the REB Competence-Based Curriculum (CBC) for primary
mathematics (an EIDU export). There is no teaching content to author or generate:
no \`Lesson\`, \`Activity\`, or \`Material\`, and no deliverables. You browse and align
against it; you do not author lessons into it.

## The hierarchy

A single \`StandardsFramework\` root, then a pure \`hasChild\` tree of
\`StandardsFrameworkItem\`s whose **kind is their level** (their \`statementType\`).
The CBC nests deeper than most, and each Unit fans out into a Key Unit Competence
plus three objective strands:

\`\`\`
Grade (Primary 1 / Primary 2 / Primary 3)
  └─ Grade Key Competence          (the grade's overarching competence)
       └─ Topic Area               (a broad maths domain)
            └─ Sub-Topic Area      (a sub-domain within the topic area)
                 └─ Unit           (a teaching unit)
                      ├─ Key Unit Competence               (the unit's target competence)
                      ├─ Knowledge Objective               (knowledge & understanding)
                      ├─ Skills Objective                  (skills)
                      └─ Attitudes and Values Objective    (attitudes & values)
\`\`\`

The three objective strands (Knowledge / Skills / Attitudes and Values) are the
finest standards leaves. A \`LearningComponent\` \`supports\` an objective (or a Key
Unit Competence) — the fine-grained skills EIDU attaches beneath the standards.

## Only two edge types

- \`hasChild\` — the containment tree above (Grade → … → objectives).
- \`supports\` — a \`LearningComponent\` to the SFI it elaborates.

There is **no** \`hasPart\`, no \`hasEducationalAlignment\`, and no ordinal field —
sequence is traversal order, not a \`position\`.

## Conventions

- **Kinds are the graph's own words** — an SFI's level is its \`statementType\`
  (\`Grade\`/\`Grade Key Competence\`/\`Topic Area\`/\`Sub-Topic Area\`/\`Unit\`/\`Key Unit
  Competence\`/\`Knowledge Objective\`/\`Skills Objective\`/\`Attitudes and Values
  Objective\`); the fine-grained skills are \`LearningComponent\`s by label.
- **No content authoring, no coverage.** This framework exists to be browsed and
  aligned against, not to hold generated materials — nothing to "complete", so no
  coverage expectations.
- **Deleting is bulk and cascades.** \`delete_nodes\` / \`delete_edges\` each take an
  ARRAY (one atomic draft edit, all-or-nothing). \`delete_nodes\` cascades along
  \`hasChild\`: removing an SFI takes its descendants and their incident
  \`supports\`/\`hasChild\` edges. The dry-run WARNS with the full set before you
  confirm (no force flag).
`;
