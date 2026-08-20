# CE1 Reading — graph guide

How the CE1-reading knowledge graph is shaped, and how to author it. Guidance for
you (the LLM), not machine config: the server already parses the graph; read this
to know the conventions before you walk or edit it.

## The subject in one line

A **bilingual** (Wolof L1 / French L2) reading programme organised by **week**. The
`Semaine` (week) is the teaching unit; the weeks sit under a content **`Course`**
root (the *guide de l'enseignant* deliverable), which also carries the routines and
formatters that shape how each week is generated (see *Generating documents*).

## Two layers

- **Content layer (what a teacher delivers).** A `Course` root —`hasPart`→ its
  `Semaine` (week) groupings —`hasPart`→ their `Jour` day groupings (`Jour 1`…`Jour
  5`) —`hasPart`→ that day's `Lesson` sessions. ~22 weeks, 5 days each, ~22 sessions
  a week.
- **Standards spine (what the sessions teach).** A `StandardsFramework` root
  —`hasChild`→ `StandardsFrameworkItem`s. A reading SFI's **kind is its skill area**
  (its `statementType`): `Lecture`, `Écriture / Copie`, `Grammaire`, `Conjugaison`,
  `Orthographe`, `Vocabulaire`, `Production d'écrits`, `Expression orale`,
  `Récitation` (an SFI with no statementType reads as the generic
  `StandardsFrameworkItem`). A `LearningComponent` `supports` the SFI it belongs to.

## How the layers connect

Each `Lesson` `hasEducationalAlignment` → the skill-area SFI it teaches (a
"Production d'Écrits" session aligns to a `Production d'écrits` SFI). That alignment
is how a session knows its objective — do not copy the objective's text onto the session.

## One parent per node

Unlike maths, a reading `Lesson` (and a `LearningComponent`) has **exactly one
containment parent** — its `Jour` via `hasPart`. (A routine attached to a session is
a `usesRoutine` edge, not containment — see *Generating documents* — so it is not a
second parent.) There is no schedule axis here, so a session with two `hasPart`
parents is a genuine mistake.

## Bilingual convention

Titles and text carry both languages — Wolof (L1) first, French (L2) after a slash
("Tari-Taalif / Poésie-Récitation"); `raw.inLanguage` records the language. The
Wolof is load-bearing, not decoration — preserve it when you author or edit a session.

## Authoring conventions

- **Add a session:** create a `Lesson` under its `Jour` (`hasPart`), give it a
  `position`, and align it to the skill-area SFI it teaches (`hasEducationalAlignment`).
- **Numbering** is the grouping's `position` (week number, day number); membership
  is the edge, so repositioning never cascades.
- **Kinds are the graph's own words** — a grouping's `groupName` (`Semaine`/`Jour`),
  an SFI's `statementType` (the skill area), a content leaf's LC `label` (`Lesson`).

## Removing content

- **`delete_nodes` and `delete_edges` are bulk.** Both take an ARRAY of ids and
  remove one or many in ONE atomic draft edit (one dry-run + one confirm) — not one
  round-trip per item. All-or-nothing: a missing id, or an id listed twice, blocks
  the whole batch.
- **`delete_nodes` cascades along containment** (`hasPart`). Because reading has one
  parent per node (see above), the cascade is clean: deleting a `Jour` takes its
  sessions, deleting a `Semaine` takes its `Jour`s and their sessions — plus every
  edge incident to a removed node. The dry-run WARNS with the FULL set that will
  vanish; read it before confirming (no force flag).
- **To keep a subtree, detach first:** `delete_edges` the `hasPart` edge into the
  node, then `delete_nodes` it — the detached sessions survive.
- Both are DRAFT edits — nothing is live until `publish_draft`.

## Coverage expectations

There are no automatic coverage warnings on an edit, `diff_draft`, or publish —
`review_draft` checks all of them against the draft and reports any it finds:

- **No empty week or day** — every `Semaine` has `Jour`s, and every `Jour` has at
  least one `Lesson`.
- **One parent per session** — a `Lesson` (or `LearningComponent`) has exactly one parent.
- **Every session aligned** — each `Lesson` has a `hasEducationalAlignment` edge to
  the skill-area SFI it teaches; an unaligned session is unmoored from the curriculum.

## Generating documents from the graph

The deliverable is the **bilingual weekly teacher guide** (*guide de l'enseignant·e /
gindeekukaayu jàngalekat bi*), rooted at the content `Course`. The graph carries most
of what generation needs — read it rather than inventing.

**The Course carries the lessons *and* the routines and formatters.** Two kinds of
authored spec ride the graph via `usesRoutine`:

- a session `Lesson` `usesRoutine` a **routine** — the ordered steps, timing, and
  scripted teacher/pupil moves that fix that session type's phase structure;
- the `Course` `usesRoutine` **formatters** — reusable specs that fix the document's
  look and its shared conventions (bilingual page layout and cue codes, modelling
  tables, analysis grids, illustration placeholders, and so on).

**These are authored data, not a fixed set.** A curator can add, swap, or remove
courses, routines, and formatters (via the catalog — `use_routine` / `use_formatter`).
So **discover them from the graph** for the session and Course at hand rather than
assuming which exist: follow whatever routine a session carries, and apply whatever
formatters its Course carries.

**The guide is self-contained.** The reading texts (*Jukki*), their illustrations, the
vocabulary, the questions, the exercises and the expected answers all live inside it.
Never reference a separate pupil book or cite a page ("turn to page …").

### Reading a week from the graph

Walk the week `Semaine` → its `Jour 1`…`Jour 5` day groupings → the day's session
`Lesson`s in `position` order. For each session, `get_standards(session)` gives the
skill-area SFI it teaches (the *osTexte*) and its components, and the session's
`usesRoutine` routine gives the phases to follow. **Produce exactly the sessions the
graph returns, in order**, with each session's language and duration — none added,
dropped, or reordered. Follow the routine's steps as the session's phase spine (do
not thin them out), and apply the Course's formatters for layout, cues, and shared
conventions. A `remediation` session teaches no standard (`get_standards` is empty).

When a session already carries **authored content** (`Activity` / `Material` under it
via `hasPart`), render it **faithfully** — do not paraphrase, merge, reorder, or
"improve" an approved phase. When it carries none, compose the session freely to the
same grain, following its routine.

Write **native-quality Wolof** throughout — preserve every diacritic (ñ, ŋ, à, é, ë,
ó), use full word forms, and never substitute a French calque where a Wolof term exists.

### Characters & reading texts

The programme's world is one connected family — **reuse it, don't invent a new lead**:
**Mari** and **Badu** (twins, ~8–9), **Omar Ndaw** (*Baay Omar*, the father), **Astou
Diop** (*Yaay Astu Jóob*, the mother), **Póol**, **Rëne** (an uncle), and the
*maîtresse*. Keep texts anchored in everyday Senegalese life (compound, school,
market, village, fields, well).

Compose the week's reading text(s) (*Jukki*) yourself and print them **in full** inside
the relevant session: genre-faithful to the week's target, CE1-decodable (short
sentences, common vocabulary), each with a title (*Boppu jukki*), a short target-word
lexicon, a *Màndargay jukki* grid for descriptive work, and text-dependent questions with
the expected answer given for the teacher.

### Missing official wording

Take OS / competency / palier wording **verbatim** from the tools. When they do not
supply a required official statement, insert a **visible placeholder**
(`[à compléter : libellé officiel du palier N]`) and continue — never fabricate an
official-sounding line.
