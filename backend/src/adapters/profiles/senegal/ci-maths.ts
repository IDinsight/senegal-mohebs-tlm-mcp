/*
 * Subject profile: CI maths (data, not behavior).
 *
 * The converged `{ nodes, relationships }` LC envelope. Two axes read through
 * edges — schedule (week→OS) and content (chapter→lesson→OS). A `chapter` is a
 * content LessonGrouping; a `lesson` is a content Lesson aligned to its spine
 * `expectation` (the objectif spécifique). The bilan is canonical data
 * (educationalUse "Assessment" → isAssessment in parseGraph); the coded coverage
 * rules were retired in phase 2c, so expectations live in the guide's prose. See
 * docs/design-notes/graph-native-authoring.md.
 */
import type { SubjectProfile } from "../../profile.js";

export const CI_MATHS_PROFILE: SubjectProfile = {
  id: "ci-maths/nodes-relationships-v1",
  capabilities: { exampleDomainRotation: true },

  // Kinds come straight from the graph's canonical fields: a chapter is a
  // LessonGrouping named `Chapitre`, a week one named `Semaine`; a lesson is a
  // `Lesson`, a standard a `Standard` (its normalizedStatementType). No role table.
  parse: {
    // The maths standards spine carries its ordinal in metadata.order (its SFIs
    // have no `position`), so the ordinal source is "order".
    numberFrom: "order",
    // Chapter progression is the canonical content prerequisite (read reversed
    // into buildsTowards/buildsFrom).
    dependencyEdge: "hasDependency",
  },
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

## Querying the graph

- Every walk is paginated. Use \`limit:50\` and page with \`cursor\` — do not
  raise \`limit\`.
- Set \`includeEdges:false\` unless you specifically need the edges to
  reconstruct a subgraph.
- Narrow with \`nodeTypes\` and \`edgeTypes\`. \`direction:'both'\` without
  \`nodeTypes\` reaches the whole graph; avoid it.
- Common recipes:
    * All SFIs in a domain: fromId=<domainId>, direction='out',
      edgeTypes=['hasChild'], nodeTypes=['StandardsFrameworkItem'].
    * All lessons in a course: fromId=<courseId>, direction='out',
      edgeTypes=['hasPart','hasChild'], nodeTypes=['Lesson'].
    * A lesson's current alignments: fromId=<lessonId>, direction='out',
      edgeTypes=['hasEducationalAlignment'], maxDepth=1.

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

## Removing content

- **\`delete_nodes\` and \`delete_edges\` are bulk.** Both take an ARRAY of ids and
  remove one or many in ONE atomic draft edit (one dry-run + one confirm) — not one
  round-trip per item. All-or-nothing: a missing id, or an id listed twice, blocks
  the whole batch.
- **\`delete_nodes\` cascades along containment** (\`hasPart\`/\`hasChild\`): it removes
  each node, every descendant whose parents are ALL in the deleted set, and every
  edge incident to a removed node. The dry-run WARNS with the FULL set that will
  vanish — read it before confirming; seeing the cascade is the safety (no force flag).
- **The two-parent rule changes what cascades.** A lesson hangs under BOTH its
  \`Chapitre\` (\`hasPart\`) and its \`Semaine\` (\`hasChild\`), so deleting the \`Chapitre\`
  alone does NOT take its lessons — they still hang under their week, and only the
  chapter's \`hasPart\` edges drop. To remove a lesson, delete the \`Lesson\` itself
  (its own \`Activity\` tasks, which have only that parent, cascade with it).
- **To keep a subtree, detach first:** \`delete_edges\` the containment edge into the
  node, then \`delete_nodes\` it — the now-detached children survive.
- Both are DRAFT edits — nothing is live until \`publish_draft\`.

## Coverage expectations

A well-formed chapter satisfies these. There are no automatic coverage warnings on
an edit, \`diff_draft\`, or publish — \`review_draft\` checks all of them against the
draft and reports any it finds:

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

## Generating documents from the graph

The graph gives you the curriculum; the **routines** give you each document's section
structure; the **formatters** on each \`Course\` give you the look. What follows is the
**authoring judgment** that sits on top — the part that is neither structure nor style.

There are two deliverables, each its own \`Course\` (find it in \`namespace_stats.roots\`
by its \`description\`):
- the **Student's Book** — the \`Course\` whose \`description\` is **"Outil de l'élève"**
  (the illustrated pupil manual, one chapter at a time);
- the **Teacher's Guide** — the \`Course\` whose \`description\` is **"Guide de
  l'enseignant"** (the lesson sheets — *fiches de leçon* — for a chapter).

Read a lesson's objective and sub-skills with \`get_standards(lessonId)\`: the aligned
\`StandardsFrameworkItem\` \`description\` is the OS text, and its \`LearningComponent\`s are
the sub-skills an activity targets. Empty \`nodes\` means that lesson is not yet wired to
the spine — say the OS is missing, don't invent it.

### Conventions for both deliverables

- **French only.** Titles, prose, activity prompts, teacher speech, metadata — all
  French. \`get_terminology\` returns a French *and* a Wolof rendering; use **only** the
  French, and never place the Wolof form in a maths document.
- **Faithful to curriculum vocabulary.** Use each lesson's OS text (from
  \`get_standards\`) verbatim and the official terms from \`get_terminology\`; do not
  paraphrase an objective or swap a synonym for a key mathematical term. The term stays
  exact in the **title, the "Je retiens", and the teacher metadata**. (A child-facing
  question stem may be simplified to a concrete phrasing — see below — as long as the
  key term still appears in those three places.) If a term's official wording is
  missing, say so rather than invent it.
- **Everyday Senegalese life.** Set scenes in the market, compound, village, schoolyard,
  fields, garden, well, roadside — **avoid classroom interiors** unless the objective
  genuinely needs one (a board or ten-frame demo) with no everyday alternative. Use
  Senegalese names (Awa, Moussa, Binta, Samba, Fatou, Ibrahima…) and objects (mangues,
  oranges, paniers, calebasses, cauris, tam-tams, pirogues). Reuse the **characters
  already established** across the book (read a recent document with \`list_documents\` /
  \`get_document_text\`) and adopt a **fresh example domain** each chapter
  (\`suggest_fresh_domain\` / \`domain_usage\`), so successive chapters vary their objects.
- **Pedagogy (APC + enseignement explicite).** The teacher models, then guides, then
  pupils practise; skills are set in realistic situations; move concrete → abstract;
  treat errors as learning (distractors are real misconceptions); keep text minimal.

### Student's Book (chapters — "Outil de l'élève")

**The golden rule: a 6-year-old answers by LOOKING, not by REMEMBERING.** CI pupils
barely read and cannot hold an abstract set in working memory. Every activity must be
solvable purely by looking at its **own** image. If answering needs the child to recall
the opening scene, flip to another page, or reconstruct a set that isn't drawn right
there, the activity is wrong — redesign it.

**Self-contained images.** Everything needed to answer is drawn inside that one activity
image: if the question is about "le grand panier", the basket is drawn there; a
*réunion* draws both source baskets; a *partition* draws the set to be sorted; a
comparison draws both groups in each option panel.

**Decidable, never self-answering questions.**
- Ban tautological "identify-then-verify" stems (e.g. *"Montre le sous-ensemble des
  tomates. Est-il inclus dans le grand panier ?"* — it answers itself).
- **Inclusion is a real question only when a *separate* candidate is tested against a
  drawn reference:** draw the reference set, then three candidate baskets (A/B/C), and
  ask which one *could come entirely from* it. The correct candidate uses only objects
  present in the reference; distractors introduce at least one that isn't.
- **One idea per question** — never chain "do X, and is Y true?".
- The child-facing stem stays concrete and answerable by looking (*"Quel petit panier
  peut sortir du grand panier ?"*); the abstract term (inclusion, partition, réunion)
  lives in the title / "Je retiens" / metadata.

**CI calibration.** Keep every group to about **five objects or fewer** (subitisable at
a glance); make the correct option verifiable by direct visual matching against the
drawn stimulus; make distractors **visible misconceptions** ("included because it's also
a vegetable", "sorted but one item left behind", "joined but one basket forgotten"), not
random noise; and **vary the correct letter** across activities (don't let it sit on A).

**The amorce scene.** Before writing it, review *all* the chapter's components (from
\`get_standards\`) and pick a scene rich enough to seed every activity image. It is the
reference the **bilan** points back to, so draw the relevant set(s) with small,
countable quantities, and make its warm-up questions decidable from the drawn scene.

**Chapter coverage.** Judge coverage **per lesson**: every non-bilan lesson is targeted
by at least one activity (if several lessons share a component, each still gets its own),
and wherever the OS supports it a lesson gets **two distinct** activities. The bilan's
questions together cover every non-bilan OS and stay decidable from the amorce image.

**Two-pass generation.** Write the whole chapter *before* generating any image.
- *Pass 1* — produce the complete \`.docx\`, and wherever an image belongs insert a
  labelled \`[IMAGE: <id>]\` description block instead: self-contained enough to hand
  straight to the image generator, specifying the stimulus (if any) **and all three
  A/B/C choices**, because the choices appear **only in the image** and are never written
  as text. (The bilan has no image — it refers back in words to the amorce.)
- *Pass 2* — generate the **amorce first** (it fixes the cast and palette), then each
  activity image; **check every finished image against its answer key** (correct option
  present, at the intended letter, uniquely correct; counts and contents match) and
  regenerate any that don't; then embed. Ratios, on-page sizes, the art-style block to
  prepend, and image compression all come from the **formatters** — read them, don't
  reinvent them.

Pupils do not write in the book (MCQ; the pupil writes only the letter).

### Teacher's Guide (lesson sheets — "Guide de l'enseignant")

The five-step structure, its names, its timings, and each step's spec come from the
**"Fiche de leçon — enseignement explicite" routine** (including the first-lesson /
intermediate / bilan variants and the bilan's question split) — read it via
\`walk_graph\`, don't restate it. The house style comes from the guide's **formatter**.
What follows is the delivery judgment on top.

- **Low-cost, blackboard-first (the load-bearing constraint).** Schools cannot buy
  props, so the teacher demonstrates **primarily on the blackboard** — chalk drawings,
  tally marks, and closed loops ("patates") standing for the ensembles and
  sous-ensembles. Beyond the board, use **only free, already-available** supports: chalk
  and board, the pupils' slates (*ardoises*), their fingers, and small no-cost items they
  can gather themselves (*cailloux, cauris, bâtonnets, capsules*). **Never** ask the
  teacher to buy or bring real produce or baskets — represent them as **drawings on the
  board**. This holds for every step, and especially the JE FAIS steps.
- **No images.** Lesson sheets contain no image of any kind — not even the amorce
  picture. Where a lesson evokes the opening scene, the teacher does so in words and may
  point pupils to the picture in **their own** manual (*"Regardez bien l'image de votre
  manuel…"*).
- **Writing voice.** Third-person narration ("le maître présente / pose / lit" — "les
  élèves ouvrent / répondent / justifient"); teacher speech as **\`E dit : « … »\`**;
  emphasis on key words via **UPPERCASE** (GAUCHE, PLUS LOURD, DIZAINE), not bold. (The
  colours these take come from the formatter.)
- **Delivery rules.** Lessons run ~30 minutes; the teacher reads every instruction aloud
  (pupils cannot read yet); at independent practice pupils write **only the letter**
  (A/B/C); one sheet = one lesson = one OS (two at most if closely linked — and where
  several lessons share an OS, differentiate the sheets by facet: discovery,
  manipulation, consolidation). Each sheet's activities build **directly** on the pupil
  manual's activities for the same OS.
`;
