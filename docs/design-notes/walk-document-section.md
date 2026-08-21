# `walk_document_section` — the document section as the generation unit

> **Status: Proposal.** Nothing here is built. It sketches a document-first generation
> reader anchored on a `DocumentSection`, and argues it should become the primary
> "generate one piece" primitive — subsuming the curriculum-first
> **`walk_lesson`** ([`../../backend/src/curriculum/lesson.ts`](../../backend/src/curriculum/lesson.ts),
> live) once the TLMs carry a section spine. It builds on the document model in
> [`teaching-learning-materials.md`](teaching-learning-materials.md) and the
> document-scope reader [`walk_document`](teaching-learning-materials.md)
> (`curriculum/documents.ts::documentSubgraph`). Prerequisite: `DocumentSection`
> spines, which the model already supports but **no live graph has authored yet**
> (ci/maths' two TLMs both use the `covers→Course` fallback — zero `DocumentSection`s).
>
> **Direction (decided):** *remain flexible* — do not bake a 1-lesson-=-1-section
> assumption into the architecture. That assumption is exactly what `walk_lesson`'s
> reverse-lookup depends on (see "Open questions"), so the flexibility requirement
> settles the design in favour of the section anchor: `walk_document_section` is the
> primary generation reader we build toward, and `walk_lesson` is an **interim
> convenience** for the current spine-less graph, not the long-term entry point.

## The question this answers

We have three generation readers, at three scopes:

| Reader | Anchor | Answers |
|---|---|---|
| `walk_document(tlmId)` | whole TLM | "produce this entire document" |
| `walk_lesson(lessonId)` | one `Lesson` | "given this lesson, what do I teach?" |
| **`walk_document_section(sectionId)`** *(proposed)* | one `DocumentSection` | "what goes in this slot of this document?" |

`walk_lesson` is **curriculum-first**: it starts from a lesson and has to *reverse-resolve*
the document context — scan every TLM for a `covers` edge that reaches the lesson, take
its formatters; resolve the routine by walking *up* the containment tree to the Course.
A `DocumentSection` is **document-first**: it already *is* the binding — it hangs under
exactly one TLM (`hasPart`) and it `covers` its curriculum node. Nothing to reverse-search.

## Why the section is the more correct unit

Generation is document-driven: a `.docx` is produced **section by section**, which is
exactly what the `DocumentSection` spine is *for*. Anchoring on the section — instead of
the lesson — buys three things `walk_lesson` structurally cannot give:

1. **Unambiguous document scope.** A section belongs to one TLM, so *its* formatters,
   *its* `assemblyGuide`, and *its* routine are unambiguous. `walk_lesson` has to return
   formatters grouped **per covering TLM** and take an optional `tlmId` to disambiguate —
   a symptom of anchoring on the wrong node.

2. **It dissolves the routine-home problem.** The Fiche routine is Teacher's-Guide-specific,
   but both documents share one `Course`. At the **lesson/Course** level there is no place
   to hang a document-specific routine — which is precisely why the routine collapse
   (see [`../reference/learning-commons/README.md`](../reference/learning-commons/README.md)
   and PR #156) had to put the Fiche on the *shared* Course, inherited document-agnostically.
   At the **section** level the discrimination point exists: a Teacher's-Guide section can
   carry (or inherit from its own TLM) the Fiche, while a Student's-Book section carries
   the manual's structure. **The section is the missing per-document anchor.**

3. **It addresses non-lesson output.** A document is not only lessons: cover pages, a table
   of contents, chapter intros, a chapter **bilan**. Those are sections that `covers` a
   `LessonGrouping`, or nothing (front-matter). `walk_lesson` can only reach a `Lesson`;
   the section reader reaches every slot of the document.

## The reader contract (sketch)

`walk_document_section(sectionId, slot?)` → resolve, for one `DocumentSection`:

```
section        the DocumentSection node (its own position + assemblyGuide, if any)
document       the owning TLM: id, assemblyGuide, audience/mediumType         (walk up hasPart to the TLM root)
covers         the curriculum node(s) this section renders                    (its covers targets; [] ⇒ front-matter)
curriculum     the covered subtree as raw nodes+edges                         (pure hasPart/hasChild from the covers targets)
routine        the InstructionalRoutine that applies, nearest-wins:           (see resolution below)
                 section's own usesRoutine → else the owning TLM's → else the covered Course's
formatters     the owning TLM's Formatter/FormatterSpec stack + any per-section formatters
```

Resolution rules, all now **document-scoped by construction** (the section fixes the document):

- **Formatters** — the section's own `hasPart` Formatter stack, unioned with the owning
  TLM's doc-wide stack. No TLM iteration; the owning TLM is a single `hasPart` walk up.
- **Routine** — nearest-wins along a *document-first* chain: the section's own
  `usesRoutine`, else the owning **TLM's**, else (compat with today) the covered Course's.
  This is where a document-specific routine finally has a home — on the section or its TLM,
  not the shared Course.
- **Curriculum** — pure `hasPart`/`hasChild` from the `covers` targets, identical to
  `walk_document`'s curriculum walk (formatting never leaks through the curriculum axis).

Read-only, slot-aware (`published` default; role-gated `draft`) like the other `walk_*` readers.

## What it takes to get there

1. **Author `DocumentSection` spines** on the two ci/maths TLMs — one section per lesson
   (plus front-matter + bilan sections), each `covers` its curriculum node. This is a data
   change through the curator loop (`add_nodes` DocumentSection + `create_edges` covers +
   `hasPart` under the TLM), no redeploy. `walk_document` already prefers a spine when
   present (`scope: "sections"`), so authoring the spine also upgrades the whole-document read.

2. **Move the routine onto the document** once spines exist: attach the Fiche to the
   Teacher's-Guide TLM (or its sections), and drop the shared-Course `usesRoutine` edge.
   This is the "Option B" we deferred when collapsing the routine — the section spine is the
   precondition that makes it clean. (`usesRoutine` from a TLM is non-canonical; hang it the
   way formatters already hang under the TLM, and register the deviation in the LC README.)

3. **Add `walk_document_section`** (`curriculum/documents.ts` or a sibling), mirror it in
   `get_capabilities.discovery`, and point the ci/maths **guide** at it as the per-piece
   generation entry.

## Relationship to `walk_lesson`

`walk_lesson` stays useful only as long as the graph is spine-less: it is the reader that
*works today* against lessons-under-a-Course with no `DocumentSection`s. Once spines exist,
`walk_document_section` **subsumes** it — "generate lesson X" becomes "generate the section
of document D that covers lesson X", which is the honest shape of the task. At that point
`walk_lesson` should either become a thin convenience that finds the covering section and
delegates, or be retired. We should not invest further in the lesson-first path before
deciding this.

## Open questions

- **One curriculum node, many sections?** *(Resolved by the flexibility requirement — kept
  here as rationale.)* `walk_lesson` works **backwards**: hand it a lesson and it infers the
  document context by asking "which section(s) cover this lesson?" That reverse step is only
  unambiguous when a lesson maps to **exactly one** section per document. Example: if the
  Teacher's Guide ever splits *"découvrir les nombres de 1 à 5"* across two fiches — page A
  (discovery + modelling), page B (guided practice + bilan) — both sections `covers` the same
  lesson, and `walk_lesson(lesson)` can no longer say **which page** you are generating. Only
  `walk_document_section(pageB)` is precise. Today ci/maths holds a 1:1 mapping (the guide's
  "one sheet = one lesson = one OS"), so `walk_lesson` is adequate *for now* — but a workbook
  or a multi-page manual chapter would break 1:1, and we have decided to **stay flexible**
  rather than assume it. Hence the section anchor is the target, not the lesson.
- **Routine granularity** — TLM-level (one routine per document) vs section-level (a bilan
  section overrides with an assessment routine). The nearest-wins chain supports both; the
  question is where authors will actually put it.
- **Do we keep `walk_lesson` at all** post-spine, or retire it? Decide before authoring the
  spines, so the guide points at one entry point, not two.
