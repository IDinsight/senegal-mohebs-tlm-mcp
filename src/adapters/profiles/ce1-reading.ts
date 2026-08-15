/*
 * Subject profile: CE1 reading (data, not behavior).
 *
 * A "unit" is a WEEK (semaine). Each week is a content `LessonGrouping` holding
 * Jour 1–5 `day` groupings, each holding that day's session `Lesson`s, which
 * align to the spine `expectation` they teach. The parse keeps only that content
 * spine + its standards/components + the content layer (the content-reachable
 * prune); everything else is dropped to keep the store lean. See
 * docs/design-notes/graph-native-authoring.md (Scope B/C).
 */
import type { SubjectProfile } from "../profile.js";

export const CE1_READING_PROFILE: SubjectProfile = {
  id: "ce1-reading/nodes-relationships-v1",
  capabilities: { exampleDomainRotation: false },

  // Kinds are canonical: a week is a LessonGrouping named `Semaine`, a day one
  // named `Jour`; sessions are `Lesson`s and standards are `Standard`s. No role
  // table. The ordinal (week/day number) is the canonical LC `position` — reading's
  // Lessons carry only `position`, so the ordinal source is "position".
  parse: {
    numberFrom: "position",
    prune: { strategy: "content-reachable-from-roots", rootKinds: ["Semaine"] },
  },

  deliverables: [
    { key: "teacher_guide", label: "Guide de l'enseignant·e (teacher guide)", scopeKind: "Semaine", match: "default", dependsOn: [], promptFile: "PROMPT_generate_lessons.md" },
  ],
};

// The authored GRAPH GUIDE for CE1 reading (phase 2c) — markdown the LLM reads to
// interpret and author the graph. See docs/design-notes/authorable-catalog.md.
export const CE1_READING_GUIDE = `# CE1 Reading — graph guide

How the CE1-reading knowledge graph is shaped, and how to author it. Guidance for
you (the LLM), not machine config: the server already parses the graph; read this
to know the conventions before you walk or edit it.

## The subject in one line

A **bilingual** (Wolof L1 / French L2) reading programme organised by **week**.
There is no chapter and no \`Course\` node — the \`Semaine\` (week) is the unit.

## Two layers

- **Content layer (what a teacher delivers).** A \`Semaine\` (week) —\`hasPart\`→ its
  \`Jour\` day groupings (\`Jour 1\`…\`Jour 5\`) —\`hasPart\`→ that day's \`Lesson\`
  sessions. ~22 weeks, 5 days each, ~22 sessions a week.
- **Standards spine (what the sessions teach).** A \`StandardsFramework\` root
  —\`hasChild\`→ \`StandardsFrameworkItem\`s. A reading SFI's **kind is its skill area**
  (its \`statementType\`): \`Lecture\`, \`Écriture / Copie\`, \`Grammaire\`, \`Conjugaison\`,
  \`Orthographe\`, \`Vocabulaire\`, \`Production d'écrits\`, \`Expression orale\`,
  \`Récitation\` (an SFI with no statementType reads as the generic
  \`StandardsFrameworkItem\`). A \`LearningComponent\` \`supports\` the SFI it belongs to.

## How the layers connect

Each \`Lesson\` \`hasEducationalAlignment\` → the skill-area SFI it teaches (a
"Production d'Écrits" session aligns to a \`Production d'écrits\` SFI). That alignment
is how a session knows its objective — do not copy the objective's text onto the session.

## One parent per node

Unlike maths, a reading \`Lesson\` (and a \`LearningComponent\`) has **exactly one
parent** — its \`Jour\` via \`hasPart\`. There is no second (schedule) axis here, so a
session with two parents is a genuine mistake.

## Bilingual convention

Titles and text carry both languages — Wolof (L1) first, French (L2) after a slash
("Tari-Taalif / Poésie-Récitation"); \`raw.inLanguage\` records the language. The
Wolof is load-bearing, not decoration — preserve it when you author or edit a session.

## Authoring conventions

- **Add a session:** create a \`Lesson\` under its \`Jour\` (\`hasPart\`), give it a
  \`position\`, and align it to the skill-area SFI it teaches (\`hasEducationalAlignment\`).
- **Numbering** is the grouping's \`position\` (week number, day number); membership
  is the edge, so repositioning never cascades.
- **Kinds are the graph's own words** — a grouping's \`groupName\` (\`Semaine\`/\`Jour\`),
  an SFI's \`statementType\` (the skill area), a content leaf's LC \`label\` (\`Lesson\`).

## Coverage expectations

The server checks the first two automatically (advisory — they never block a
publish); \`review_draft\` checks all of them:

- **No empty week or day** — every \`Semaine\` has \`Jour\`s, and every \`Jour\` has at
  least one \`Lesson\`.
- **One parent per session** — a \`Lesson\` (or \`LearningComponent\`) has exactly one parent.
- **Every session aligned** — each \`Lesson\` has a \`hasEducationalAlignment\` edge to
  the skill-area SFI it teaches; an unaligned session is unmoored from the curriculum.
`;
