/*
 * Subject profile: CI maths (data, not behavior).
 *
 * The converged `{ nodes, relationships }` LC envelope. Two axes read through
 * edges — schedule (week→OS) and content (chapter→lesson→OS). A `chapter` is a
 * content LessonGrouping; a `lesson` is a content Lesson aligned to its spine
 * `expectation` (the objectif spécifique). The bilan is canonical data
 * (educationalUse "Assessment" → isAssessment in parseGraph), surfaced by the
 * exactly-one-assessment-child coverage rule below. See
 * docs/design-notes/graph-native-authoring.md.
 */
import type { SubjectProfile } from "../profile.js";

export const CI_MATHS_PROFILE: SubjectProfile = {
  id: "ci-maths/nodes-relationships-v1",
  capabilities: { exampleDomainRotation: true },

  // Kinds come straight from the graph's canonical fields: a chapter is a
  // LessonGrouping named `Chapitre`, a week one named `Semaine`; a lesson is a
  // `Lesson`, a standard a `Standard` (its normalizedStatementType). No role table.
  parse: {
    numberFrom: "order",
    // Chapter progression is the canonical content prerequisite (read reversed
    // into buildsTowards/buildsFrom).
    dependencyEdge: "hasDependency",
  },

  // Teacher guide filenames contain "fiche(s) de leçon"; the pupil manual is the
  // default (everything else). Mutually exclusive → each file is exactly one.
  deliverables: [
    { key: "manual", label: "Manuel de l'élève (pupil book)", scopeKind: "Chapitre", match: "default", dependsOn: [], promptFile: "PROMPT_generate_chapter.md" },
    { key: "lessons", label: "Fiches de leçons (teacher guide)", scopeKind: "Chapitre", match: { filenameContainsAny: ["fiches de leçons", "fiche de leçon"] }, dependsOn: ["manual"], promptFile: "PROMPT_generate_lessons.md" },
  ],

  // NOTE: multi-parent is deliberately NOT used for lessons — a lesson
  // legitimately has two parents (its week on the schedule axis, its chapter on
  // the content axis). single-content-parent counts only the CHAPTER parents
  // (via hasPart), so >1 is the genuine ambiguity.
  coverage: [
    { rule: "empty-container", kinds: ["Chapitre"] },
    { rule: "single-content-parent", childKind: "Lesson", parentKind: "Chapitre", containment: "hasPart" },
    { rule: "exactly-one-assessment-child", parentKind: "Chapitre", childKind: "Lesson", containment: "hasPart", noun: "bilan" },
  ],
};

// The authored GRAPH GUIDE for CI maths (phase 2c): markdown the authoring /
// generating LLM reads to interpret and modify the graph. It is guidance, not
// machine config — the parser already reads the graph; this narrates the
// ontology, the vocabulary, the intended hierarchy, and the authoring
// conventions the raw edges don't carry. A starter guide; expand it via
// edit_profile. See docs/design-notes/authorable-catalog.md phase 2c.
export const CI_MATHS_GUIDE = `# CI Maths — graph guide

How the CI-maths knowledge graph is shaped, and how to author it. This is
guidance for you (the LLM), not machine config: the server already parses the
graph; read this to know the conventions and intent before you walk or edit it.

## Two layers

- **Standards spine** — the official curriculum objectives. A \`StandardsFramework\`
  root holds \`StandardsFrameworkItem\` (SFI) nodes. An SFI's \`statementType\` says
  what it is: \`Objectif spécifique\` (the OS — a taught objective) and domain values
  (\`Arithmétique\`, \`Mesure\`, …). An SFI holds its sub-skills as \`LearningComponent\`
  children.
- **Content layer** — the authored teaching material. A \`Course\` (there are two: the
  Teacher's Guide and the Student's Book) holds \`LessonGrouping\`s. A grouping's
  \`groupName\` names its axis: \`Chapitre\` (content) or \`Semaine\` (schedule). A
  \`Lesson\` is one taught lesson.

## How the layers connect

A \`Lesson\` aligns to the OS it teaches with a \`hasEducationalAlignment\` edge to that
\`StandardsFrameworkItem\` — the alignment, not a copy of the objective's text, is how
a lesson "knows" its objective. A \`LearningComponent\` \`supports\` the SFI it belongs to.

## A lesson has two parents — by design

A CI-maths lesson legitimately sits under TWO containers:
- its **chapter** (a \`Chapitre\` grouping) via \`hasPart\` — the content axis;
- its **week** (a \`Semaine\` grouping) via \`hasChild\` — the schedule axis.

Both are correct. Do not "fix" a lesson that has two parents. When you re-parent,
move along ONE axis; the other containment edge is left intact.

## The bilan

A chapter's assessment (the "bilan") is a \`Lesson\` with \`educationalUse: "Assessment"\`
— it is data, not a title heuristic. Each chapter should have exactly one bilan.

## Authoring conventions

- **Add a lesson:** create a \`Lesson\` under its \`Chapitre\` (\`hasPart\`), give it a
  \`position\`, and align it to the OS it teaches (\`hasEducationalAlignment\`).
- **Ordinals** live in \`position\`; membership is the edge, so repositioning a node
  never cascades to its siblings.
- **Kinds are the graph's own words** — a grouping's \`groupName\`, an SFI's
  \`statementType\`, a content leaf's LC \`label\`. There is no separate subject "role"
  tag to set.

## Coverage expectations

A well-formed chapter satisfies these. The server checks the first three
**automatically** and warns on a violation (they are advisory — they never block a
publish); \`review_draft\` checks all of them, including the last two, which are
prose-only:

- **No empty chapter** — every \`Chapitre\` has at least one \`Lesson\`.
- **Exactly one bilan per chapter** — each \`Chapitre\` has exactly one \`Lesson\`
  flagged \`educationalUse: "Assessment"\` (the bilan).
- **One chapter per lesson** — a \`Lesson\` has exactly one \`Chapitre\` parent (via
  \`hasPart\`). Its \`Semaine\` parent (via \`hasChild\`) is a separate axis and does
  not count against this.
- **Every teaching lesson is aligned** — each non-bilan \`Lesson\` has a
  \`hasEducationalAlignment\` edge to the OS it teaches. A lesson with no alignment
  is unmoored from the curriculum.
- **Chapters are contiguous** — \`Chapitre\` \`position\`s run from 1 with no gaps or
  duplicates, so the book has no missing or double-numbered chapter.
`;
