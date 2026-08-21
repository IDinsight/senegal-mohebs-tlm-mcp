# Teaching & learning materials — documents as first-class graph nodes

> **Status: Phases 1–3 (model, explorer, generation reader) landed; phase 4 pending.**
> The four non-canonical labels (`TeachingLearningMaterial`, `DocumentSection`,
> `Formatter`, `FormatterSpec`) and the `covers` edge are creatable through the generic
> verbs (`add_nodes` / `create_edges`), round-trip faithfully through the store, and are
> kept out of the curriculum spine by the parser (they ride the raw-graph echo only —
> phase 1). The explorer has a **Documents view** rooted on the TLM (phase 2). Generation
> can now target a document: **`walk_document(tlmId)`** (`curriculum/documents.ts::documentSubgraph`)
> resolves a TLM's `assemblyGuide`, its Formatter/FormatterSpec rendering stack, and the
> curriculum it renders — a `DocumentSection` spine when present, else the `covers`-Course
> fallback (`scope: "sections" | "course" | "none"`) — and its curriculum walk is pure
> `hasPart`/`hasChild`, so formatting reaches generation only through the TLM (phase 3).
> **Deferred to phase 4 (deliberately):** dropping `usesRoutine` from `courseSubgraph`'s
> walk. The additive `walk_document` reader is the new formatter path; the *removal* of the
> old one only makes sense once the live formatter-as-`InstructionalRoutine` nodes are
> relabelled `Formatter` under a TLM (the phase-4 data migration), so removing it earlier
> would strand live formatters. It ships as the final code step of the phase-4 rollout,
> together with the data migration + Cloud Run redeploy (needs Firestore creds). Captures the decision to stop
> overloading canonical LC labels for two document concerns — *formatters* and
> *document identity* — and to model both as **explicit non-canonical labels**
> (`TeachingLearningMaterial`, `Formatter`, `FormatterSpec`) plus one non-canonical
> edge (`covers`). Supersedes the "formatter as `InstructionalRoutine`" stopgap and
> extends [`graph-linked-documents.md`](graph-linked-documents.md) (a document's
> identity is a graph node) and [`logic-in-the-graph.md`](logic-in-the-graph.md)
> (generation shrinks toward a formatter). Deviations are registered in
> [`../reference/learning-commons/README.md`](../reference/learning-commons/README.md).

## Why this exists — the two things we were faking

Both were honest stretches of canonical LC that have now diverged far enough that the
canonical label actively **mis-describes** the node:

1. **Formatters were modelled as `InstructionalRoutine`, attached to a `Lesson`.**
   Two problems. (a) *Semantics*: an LC `InstructionalRoutine` is a reusable
   **pedagogical** pattern (how you *teach*), not a **rendering** rule (how a `.docx`
   *looks*). A future reader — or a re-import into another LC tool — reads our
   formatter nodes as routines. (b) *Edges*: canon attaches a routine to an
   **`Activity`** (`usesRoutine`), not a `Lesson`, so the attachment is already
   off-canon.

2. **A document's identity was carried by a `Course`.** An LC `Course` is a *unit of
   study* (what gets taught), not a *printed artifact* (what gets produced). Modelling
   "Teacher's Guide" and "Student's Book" as two Courses over the same curriculum
   conflates the curriculum with the deliverable — and blocks the natural case of
   several artifacts (pupil manual + workbook + audio) over one curriculum subtree.

The fix in both cases is the same move: **make the divergence explicit in the label**
rather than hiding it inside a canonical one. One honest deviation beats a
mislabelled node.

## The model

Non-canonical labels for the document, its (optional) internal spine, and its
formatting, plus one **non-canonical** edge (`covers`) that binds a document-thing to
the curriculum-thing it renders — at whatever granularity:

```
TeachingLearningMaterial (TLM)              ← the document / deliverable (a new graph root)
  ├─ covers ─▶ Course                        ← coarse scope: the curriculum this doc is for (optional hint)
  ├─ hasPart ─▶ DocumentSection              ← the doc's OWN spine (opt-in; ordered by position)
  │               ├─ covers ─▶ Lesson         ← what this section renders (or LessonGrouping/Activity; or NOTHING = front-matter)
  │               └─ hasPart ─▶ Formatter → FormatterSpec   ← per-section formatting
  └─ hasPart ─▶ Formatter                     ← a doc-wide rendering concern (art style, layout, …)
                  └─ hasPart ─▶ FormatterSpec  ← one concrete rule within that concern
  · metadata.assemblyGuide (markdown)         ← THIS document's own "how to build me" logic
```

- **`TeachingLearningMaterial`** (`TLM`) — the artifact. A **new root kind**: it is
  *not* nested under a Course (it points *at* one via `covers`). Carries the
  document's descriptive fields (see below) and its authored assembly logic.
- **`DocumentSection`** — one piece of the document (a page / spread / section), when
  the document's structure diverges from the curriculum's. **Opt-in** — see
  [The section spine](#the-section-spine--optional-per-document) below. Named
  `DocumentSection`, **not `Unit`**: maths already uses `Unité`/`Module`/`Chapitre` as
  curriculum `LessonGrouping` `groupName`s, so a document "Unit" would collide with a
  curriculum "unité" in every reader's head.
- **`Formatter`** — one rendering concern the document applies (a shared art style, a
  page layout, an image bucket). Composed of specs. Attachable **doc-wide** (under the
  TLM) or **per-section** (under a `DocumentSection`).
- **`FormatterSpec`** — one concrete rule inside a formatter. **Decided: a Formatter
  is _composed of_ specs** (`Formatter ─hasPart→ FormatterSpec`, order-sensitive via
  `position`), not "one spec per formatter." This matches the current catalog, where
  art-style and layout are separate seeded pieces that combine.
- **`covers`** — the document→curriculum edge, used at **two granularities**:
  `TLM ─covers→ Course` (coarse scope) and `DocumentSection ─covers→ Lesson`
  (the authoritative per-section mapping). Not `hasPart` (the document is a sibling
  artifact, neither above nor below the curriculum) and not `hasEducationalAlignment`
  (that means "content aligns to a *standard*", and a Course/Lesson is not a
  `StandardsFrameworkItem` — overloading it would stretch *two* canonical semantics to
  save one edge name).

### Reusing `Material`? No — the containment rule blocks it

LC's `Material` is the canonical node for a concrete artifact and even carries
`materialType`, so it was the first candidate. It **doesn't fit**: canonical `Material`
may only be a **`hasPart` child of** `Course`/`LessonGrouping`/`Lesson`/`Activity` — it
lives *inside* the content tree. Our document does the opposite: it sits *above/beside*
a Course and `covers` it. A `Material` that contains a Course is backwards. So a
dedicated `TeachingLearningMaterial` label (named for the project, "TLM") is the honest
model, not a renamed `Material`.

## The section spine — optional per document

A document is a **projection** of the curriculum. The question is *where that
projection lives*: computed at generation time from the `assemblyGuide` prose, or
**materialized as data** in a `DocumentSection` spine. The answer is **it depends on
the document — so make the spine opt-in.**

**The gate: does the document's structure diverge from the curriculum's?** Over the
same curriculum, will a page ever *not* be 1:1-with-a-lesson, in curriculum order?
Divergence cases that need an explicit spine:

- one page covers a whole week (**many** lessons → **one** page);
- one lesson spreads over **several** pages (**one** → **many**);
- **front-matter** with no curriculum node at all (cover, table of contents, "how to
  use this book");
- pupil-manual granularity ≠ teacher-guide granularity over the *identical* lessons.

**Two levels of explicitness, one model:**

- **Simple (no spine).** `TLM ─covers→ Course` + the `assemblyGuide` prose ("one page
  per lesson") is enough — generation derives the page rhythm from the Course walk. A
  parallel spine here would just be a second thing to keep in sync.
- **Diverging (spine).** Materialize `DocumentSection`s under the TLM
  (`hasPart`, ordered by `position`); each `covers` the curriculum node(s) it renders.
  Generation walks the **sections** instead of the Course.

Three things fall out of the spine:

1. **`covers` is reused, not reinvented.** `DocumentSection ─covers→ Lesson` is the
   same edge as `TLM ─covers→ Course`, one granularity finer. Generation walks sections
   when they exist, falls back to the Course when they don't.
2. **Front-matter gets a home.** A `DocumentSection` with **no** `covers` target is
   document-native content (cover, TOC, intro). Today those have nowhere to live
   because every node must map to curriculum.
3. **`TLM ─covers→ Course` becomes a convenience, not the source of truth.** The
   document's real curriculum footprint = the **union of its sections' targets**. Keep
   the coarse `TLM→Course` edge as a fast orientation/explorer hint (recommended), or
   drop it and derive the footprint from the sections.

This is the **clean version of the maths "two-Course split"** (`project_maths_course_root`),
where the Student's Book was given its own `Course → chapters → container Lesson →
placeholder Activities` structure to carry a document-shaped projection — a stretch that
left reads *"intentionally broken pending an adapter rework."* That breakage is the
symptom of forcing the document's projection through the *curriculum's* canonical labels;
a dedicated `DocumentSection` label is the honest replacement.

**Recommendation:** the **pupil manual** almost certainly wants a section spine (it has
front-matter and its own chapter rhythm); the **teacher's guide** may be close enough to
1:1 to stay `covers`-only. Both shapes coexist under one model.

## Where the document-specific logic lives — authored markdown, not code

The document needs a place for its *own* generation logic ("one pupil page per lesson,
a bilan every 5th week, cover page then table of contents…"). This is **`metadata.assemblyGuide`,
authored markdown** — deliberately **not** a code field, template DSL, or per-document
render function.

Rationale: this is exactly the [`authorable-catalog.md`](authorable-catalog.md)
direction — *new thing = authored data, no per-subject/per-document code* — and it
mirrors the pattern already in use, where the subject `guide` is authored prose the
generating LLM reads. A template engine is the thing we are trying **not** to build; it
would force per-document code and take authoring away from curators. Markdown keeps the
logic curator-authorable and consumed the same way as everything else.

Three tiers, each owning exactly one concern:

| Node | Field | Owns |
|---|---|---|
| `SubjectProfile` (config cell) | `guide` (md) | subject-wide pedagogy — applies to *every* document |
| **`TeachingLearningMaterial`** | **`metadata.assemblyGuide` (md)** | *this document's* structure & generation logic |
| `Formatter` / `FormatterSpec` | rules (md, in `content`) | reusable rendering rules the assembly references |

So: **Course = what to teach · TLM = what to produce · Formatter = how to render ·
guide = the pedagogy binding them.**

## What changes for generation

Generation is LLM-driven — there is no coded render step (see
[`logic-in-the-graph.md`](logic-in-the-graph.md)). Today the composition is:

```
SubjectProfile (core + guide)
  +  Course subtree            ← the course walk follows hasPart + hasChild + usesRoutine,
                                  so formatters ride INSIDE the walk (a lesson pulls its
                                  "routine" via usesRoutine — src/curriculum/courses.ts)
```

After this change the **scope node becomes the TLM** (the natural upgrade of the
[`graph-linked-documents.md`](graph-linked-documents.md) scope-node pattern — generation
targets the document, not the curriculum), and the composition becomes explicit:

```
SubjectProfile (core + guide)
  +  TLM.metadata.assemblyGuide       ← the document's own "how to build me"
  +  the curriculum to render:
       · spine  → walk TLM ─hasPart→ DocumentSection (ordered), each ─covers→ its curriculum node
       · simple → walk TLM ─covers→ Course subtree
  +  reusable rendering rules: TLM ─hasPart→ Formatter ─hasPart→ FormatterSpec
       (doc-wide) and DocumentSection ─hasPart→ Formatter → FormatterSpec (per-section)
```

Generation resolves the curriculum by **section spine when present, Course walk
otherwise** (the same fallback described in
[The section spine](#the-section-spine--optional-per-document)).

Consequence — **formatters leave the Course walk.** They are a property of the
*document*, not the *curriculum*, so they stop riding `usesRoutine` inside the course
subtree and are reached only through the TLM. This also **cleanly re-separates**
`InstructionalRoutine` (genuine pedagogy, canonically on an `Activity`) from
`Formatter` (rendering, under a TLM) — the two were conflated only because we reused
the routine label. If there are no *real* pedagogical routines yet, `usesRoutine` can
drop out of the course walk entirely.

## TLM descriptive fields (beyond formatters + assembly)

The document node should describe itself enough that generation and the explorer can
reason over it without opening the assembly guide:

- **`audience`** — pupil / teacher (drives register, reading level).
- **`mediumType`** — print / digital / audio (drives what formatters even apply).
- **`title`** — human name ("Manuel de l'élève", "Guide de l'enseignant").
- **`metadata.assemblyGuide`** — the authored generation logic (above).
- Free **`metadata`** bag for other generation hints.

The **generated `.docx` pointer stays in document history** keyed by the TLM node id
(the existing node-keyed history from `graph-linked-documents.md`), **not** on the node
— the node is the stable identity; the rendered file is a produced output.

## Explorer — a Documents view

Add a third top-level view to the KG explorer ([`src/kg-export.ts`](../../backend/src/kg-export.ts)),
alongside the existing containment-hierarchy and by-label views, without touching them:

- **Root** at `TeachingLearningMaterial` nodes.
- **Walk `hasPart`** → `DocumentSection` (when present) → `Formatter` → `FormatterSpec`
  to show the document's spine and its rendering stack.
- **Render `covers`** as a link out to the curriculum (Course from the TLM, Lesson from
  each section) — display-only, like the existing folded alignment edges.
- New `LABEL_DEFS` entries + colours for the four non-canonical labels.

## LC deviations to register

Add to [`../reference/learning-commons/README.md`](../reference/learning-commons/README.md):

- **New labels** `TeachingLearningMaterial`, `DocumentSection`, `Formatter`,
  `FormatterSpec` — none exist in canon; intentional extensions for the
  document/rendering layer.
- **New edge** `covers` — no canonical equivalent — used at two granularities
  (`TLM → Course`, `DocumentSection → Lesson`/`LessonGrouping`/`Activity`).
- **`metadata.assemblyGuide`** — a sidecar extension (like `metadata.illustratesComponent`).
- **Retire** the "formatter as `InstructionalRoutine` on a `Lesson`" usage — it was
  never registered as a deviation because it was meant to be temporary; the new labels
  replace it.

The "we are LC-aligned" claim stays true **with these registered exceptions** — the
whole point of the deviations list is that our alignment is *canon plus a small,
documented, honest set of extensions*, not silent divergence.

## Migration (when built)

1. **Relabel** existing formatter-as-`InstructionalRoutine` nodes → `Formatter`
   (+ split their rules into `FormatterSpec` children if not already).
2. **Mint one `TeachingLearningMaterial` per existing document** — e.g. CI/maths's two
   Courses today (Teacher's Guide, Student's Book) each get a TLM:
   `TLM ─covers→ Course`, formatters re-parented under the TLM, `assemblyGuide` seeded
   from the retired prompt/guide prose. The **Student's Book**, whose current
   `Course → chapters → container Lesson → placeholder Activities` projection is the
   off-canon stretch this note replaces, is the first candidate for a
   `DocumentSection` spine (its sections `covers` the teaching lessons; front-matter
   becomes target-less sections).
3. **Re-point generation + history** at the TLM scope node.
4. Data-only where possible; the parser/explorer changes (new labels, `covers`,
   `DocumentSection`, Documents view) are **code** changes and require a Cloud Run
   redeploy, not just a re-seed — otherwise the live server silently misreads the new
   shape.

## Open questions

1. **`covers` cardinality.** Recommend **single-target for now** (one TLM covers one
   Course, one section covers one curriculum node) so generation can rely on a single
   root per document-thing; keep the edge *shape* many-to-many so a future anthology
   (or a review page spanning several lessons) doesn't need a schema change.
2. **Which existing documents get a section spine vs stay `covers`-only?** Recommend
   spine for the pupil manual (front-matter + own chapter rhythm), `covers`-only for the
   teacher's guide if it's ~1:1 with the teaching spine. Decide per document at
   migration time — the model supports both.
3. **`assemblyGuide` home** — recommended `metadata.assemblyGuide` for consistency with
   the sidecar rule; alternatively the node's `content` field. Low stakes, but pick one
   before seeding. (Same choice applies to a section's own assembly notes, if any.)
