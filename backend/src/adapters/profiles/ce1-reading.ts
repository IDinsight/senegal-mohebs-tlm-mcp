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
    prune: { strategy: "content-reachable-from-roots", rootKinds: ["Course", "Semaine"] },
  },
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

## Removing content

- **\`delete_nodes\` and \`delete_edges\` are bulk.** Both take an ARRAY of ids and
  remove one or many in ONE atomic draft edit (one dry-run + one confirm) — not one
  round-trip per item. All-or-nothing: a missing id, or an id listed twice, blocks
  the whole batch.
- **\`delete_nodes\` cascades along containment** (\`hasPart\`). Because reading has one
  parent per node (see above), the cascade is clean: deleting a \`Jour\` takes its
  sessions, deleting a \`Semaine\` takes its \`Jour\`s and their sessions — plus every
  edge incident to a removed node. The dry-run WARNS with the FULL set that will
  vanish; read it before confirming (no force flag).
- **To keep a subtree, detach first:** \`delete_edges\` the \`hasPart\` edge into the
  node, then \`delete_nodes\` it — the detached sessions survive.
- Both are DRAFT edits — nothing is live until \`publish_draft\`.

## Coverage expectations

There are no automatic coverage warnings on an edit, \`diff_draft\`, or publish —
\`review_draft\` checks all of them against the draft and reports any it finds:

- **No empty week or day** — every \`Semaine\` has \`Jour\`s, and every \`Jour\` has at
  least one \`Lesson\`.
- **One parent per session** — a \`Lesson\` (or \`LearningComponent\`) has exactly one parent.
- **Every session aligned** — each \`Lesson\` has a \`hasEducationalAlignment\` edge to
  the skill-area SFI it teaches; an unaligned session is unmoored from the curriculum.

## Generating documents from the graph

The one deliverable is the **bilingual weekly teacher guide** (*guide de l'enseignant·e /
gindeekukaayu jàngalekat bi*). The graph gives you the week's session structure and the
standard each session teaches; what follows is the **authoring judgment** on top — the
part the edges don't carry. (Reading has no \`Course\`, routine, or formatter yet, so a
session's phase structure and the document's look still come from the generation prompt;
this narrates the subject-wide conventions that outlast it.)

**The guide is self-contained.** The reading texts (*Jukki*), their illustrations, the
vocabulary, the questions, the exercises and the expected answers all live inside it.
Never reference a separate pupil book or cite a page ("turn to page …").

**Match the existing weeks.** Weeks 1–8 of this programme are the authority for structure,
register, and density. Before generating, study the week nearest in *palier and genre*
(via \`list_documents\` / \`get_document_text\`) and mirror it — do not invent a cleaner or
simpler format. When the curriculum tools return empty character or terminology lists,
**harvest names and wording from weeks 1–8** rather than inventing them.

### Reading a week from the graph

Walk the week \`Semaine\` → its \`Jour 1\`…\`Jour 5\` day groupings → the day's session
\`Lesson\`s in \`position\` order; \`get_standards(session)\` gives the skill-area SFI it
teaches (the \`osTexte\`) and its components. **Produce exactly the sessions the graph
returns, in order**, with each session's language and duration — none added, dropped, or
reordered. A \`remediation\` session teaches no standard (\`get_standards\` is empty).

When a session already carries **authored content** (\`Activity\` / \`Material\` under it via
\`hasPart\`), render it **faithfully** — do not paraphrase, merge, reorder, or "improve" an
approved phase. When it carries none, compose the session freely to the same grain.

### Bilingual conventions — three patterns by session type

- **L1 oral & comprehension** — every teacher and pupil line is **dual**: Wolof first (in
  **bold**), then the French (in *italic*); cues \`M …\` / \`E …\` (teacher) and \`LW …\` /
  \`LVs …\` (pupils).
- **L1 language-tool** (Vocabulaire, Grammaire, Orthographe, Conjugaison) — instructions
  in **French**, but the teacher's spoken prompts quoted **in Wolof** inline, and the
  corpus / "Production attendue" in Wolof; define vocabulary with the bracket-headword
  template + a *Misaal* (example).
- **L2** — **French only**, with an \`Objectif opérationnel\` that cites the *appui sur le
  wolof* (this is where L2↔L1 transfer is declared).

Write **native-quality Wolof** throughout — preserve every diacritic (ñ, ŋ, à, é, ë, ó),
use full word forms, and never substitute a French calque where a Wolof term exists.

### Density floor (the most common failure mode)

- Every phase has **at least two scripted teacher moves** with the **matching pupil
  action** written on the same row.
- Comprehension *Étape 4* has **three parts**: **Questions** (four text-dependent, each
  followed by «Noo ko xamee ? / Comment tu le sais ?» and the expected answer),
  **Reformulation**, **Expérience personnelle**.
- Vocabulary sessions define **every** target word (bracket template + *Misaal*) and have
  three pupils use each word in a sentence.
- Grammar / orthographe / conjugaison include a written **"Production attendue"** corpus
  and **manipulation before the rule**.
- **One autonomous reinvestment** activity per day.

### Characters & reading texts

The programme's world is one connected family — **reuse it, don't invent a new lead**:
**Mari** and **Badu** (twins, ~8–9), **Omar Ndaw** (*Baay Omar*, the father), **Astou
Diop** (*Yaay Astu Jóob*, the mother), **Póol**, **Rëne** (an uncle), and the
*maîtresse*. Harvest them from weeks 1–8 if the tool is empty. Keep texts anchored in
everyday Senegalese life (compound, school, market, village, fields, well).

Compose the week's reading text(s) (*Jukki*) yourself and print them **in full** inside
the relevant session: genre-faithful to the week's target, CE1-decodable (short
sentences, common vocabulary), each with a title (*Boppu jukki*), a short target-word
lexicon, a *Màndargay jukki* grid for descriptive work, and text-dependent questions with
the expected answer given for the teacher.

### Missing official wording

Take OS / competency / palier wording **verbatim** from the tools (or the exemplar). When
neither supplies a required official statement, insert a **visible placeholder**
(\`[à compléter : libellé officiel du palier N]\`) and continue — never fabricate an
official-sounding line.
`;
