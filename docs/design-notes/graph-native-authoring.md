# Graph-native authoring — target model & migration plan

> **Status: Current — implemented and live.** Landed for CI maths via PR #28
> (split + authoring/edit surface) and PR #29 (bilan as data), both merged; the
> Firestore store has been re-seeded (ci/maths: 509 nodes / 885 edges). The
> migration is reproducible via `scripts/migrate-maths-graph.mjs`. CE1 reading now has the
> content layer too (Scope A — one Lesson per language-tool standard per week;
> `scripts/migrate-reading-graph.mjs`; reads byte-identical). The fuller 22-session
> timetable (Scope B) is still prompt-hardcoded. LC type/edge vocabulary confirmed against
> the [LC Curriculum reference](https://docs.learningcommons.org/knowledge-graph/graph-reference/curriculum)
> (Activity, Material, Lesson, LessonGrouping); this project uses the graph's
> existing serialization (snake_case, `hasChild`/`supports`), not canonical LC —
> see *Representation convention* below.

## Why

The Learning Commons (LC) ontology has a **content layer** built to hold teaching
materials directly — `Course` → `LessonGrouping` → `Lesson` → `Activity` → `Material`.
Today we under-use it: the graph is read *as context* for an LLM, but the generated
guide is a freeform `.docx` that lives in Storage, disconnected from the graph. The
content and the graph drift apart; there is no single source of truth for what a
lesson actually says.

Two problems compound this:

- **A lesson and its objective are the same node.** A maths "lesson" today *is* the
  objectif spécifique (OS) — one `StandardsFrameworkItem` (role `expectation`) wears
  both hats. That bakes a 1:1 assumption into node identity, so the model cannot
  represent a lesson covering two OS, two lessons for one hard OS, or an OS with no
  lesson yet (a coverage gap you want to *see*).
- **"Chapter" is treated as knowledge, but it is presentation.** LC agrees: it
  defines `LessonGrouping` as a set of related lessons whose "naming and level may
  vary across publishers — e.g., Unit, Module, Chapter." A chapter is a renameable,
  removable grouping, not curriculum truth.

## Representation convention (decided)

New authored content uses **the graph's existing serialization**, not the canonical
LC schema — internal consistency and a simpler migration, at the cost that "faithful
re-export" continues to mean "reproduces our simplified serialization." The canonical
LC names used throughout this note map onto what we actually write as follows:

| Canonical LC (docs) | What we author (existing convention) |
|---|---|
| Labels `Lesson` / `LessonGrouping` / `Activity` / `Material` / `Course` | Label `Curriculum` + `normalized_type: "Lesson"` / `"Lesson Grouping"` / `"Activity"` / `"Material"` / `"Course"` |
| edge `hasPart` (containment) | edge `hasChild` |
| edge `hasEducationalAlignment` (coverage) | edge `supports` |
| camelCase props (`studentGroupingType`, `timeRequired`, `materialType`, `groupName`, `educationalUse`) | snake_case (`student_grouping_type`, `time_required`, `material_type`, `group_name`, `educational_use`), with an EN mirror under `metadata.en` as existing nodes do |
| `Material.content` (body) | new `content` property on Material nodes (prose/image HTML) |

So wherever this note says e.g. `Lesson —hasEducationalAlignment→ Expectation`, read it
as a `Curriculum`/`normalized_type: "Lesson"` node with a `supports` edge to the
expectation `StandardsFrameworkItem`. Detail to reconcile in implementation: existing
`supports` edges route through a `LearningComponent` intermediary — decide during build
whether lesson coverage aligns straight to the expectation SFI or via a component.

## Target model

Two layers, joined by `hasEducationalAlignment`. The **spine** is stable knowledge
(the standards); the **content layer** is authored teaching material, using real LC
node and edge types.

```
SPINE (knowledge, stable)                 CONTENT (teaching, authored — LC types)
  strand                                    Course
   └─ expectation (OS) ◄─hasEducational──── Lesson ◄─hasPart── LessonGrouping ("Chapter")
        ▲                    Alignment        │
        │ (Lesson/Activity/                   ├─hasPart→ Activity ─hasPart→ Material
        │  LessonGrouping/Material            └─hasPart→ Material          (content = HTML:
        │  may all align)                         (content = prose,         steps, examples)
   week ┘                                          scene image, …)
                                            IllustrativeTask = an Activity with an
                                            illustrative `educationalUse` — the existing
                                            RECE course, an authoring input (unchanged).
```

### Decisions

1. **Lesson ≠ Expectation.** The expectation (OS) stays on the spine as a standard.
   `Lesson` becomes a content node linked by `Lesson —hasEducationalAlignment→
   StandardsFrameworkItem`. 1:1 today, but an edge so it can be 1:many later without a
   re-model.
2. **Chapter = `LessonGrouping`** — presentational and removable, per LC's own
   definition. `groupName` holds the label ("Chapitre"); `groupLevel` / `position`
   hold ordering. It is a real node, but **deliverables may render or ignore it** —
   the teaching guide groups lessons into chapters; the student book can flatten to a
   straight lesson list. Same graph, two presentations.
3. **Coverage and progression are defined on expectations + weeks, never on
   chapters.** This is the invariant that keeps a chapter safely disposable.
   - *Coverage* = every expectation has ≥1 inbound `hasEducationalAlignment` from a
     Lesson (a gap is now a first-class query, not an accident of the old 1:1).
   - *Progression* = lessons ordered by their schedule / `position`.
4. **Scheduling ("week").** "When you teach it" is a teaching fact, not a standards
   fact. LC has no bespoke `week → Lesson` content edge; two faithful options:
   - **(preferred) derive it** — a lesson's week follows from its aligned expectation,
     which already sits under a week on the spine (`lesson → expectation → week`). No
     new edge; works cleanly while alignment is 1:1.
   - **explicit** — only if a lesson's teaching week must diverge from its standard's
     week, model it via `position`/ordering on the content tree.
5. **Prescriptive vs illustrative Activity is positional, not an enum.** Both are LC
   `Activity`. LC has no property for this axis — `educationalUse` is only
   `Instruction` | `Assessment` (teach vs test). So distinguish by *position*: an
   authored prescriptive activity is a `hasChild` of a `Lesson` (part of the teaching
   sequence); a RECE illustrative task `supports` a standard/component as an exemplar,
   and already carries `content_type: "Tâche illustrative (…)"`. Keep that marker;
   invent no new flag. Separately, `educationalUse` gives us a clean home for the
   **bilan / assessment** axis: `educationalUse: Assessment` for assessment content,
   `Instruction` for teaching content (replaces the ad-hoc `isAssessment`).
6. **`Image` is a `Material`.** LC `Material` explicitly covers images; there is no
   separate Image type. Note `materialType` (`Core` | `Supporting` | `Reference`) is
   *centrality*, not medium — an opening scene is `materialType: Core`, and its
   image-ness lives in the `content` field (HTML). If we need to query "is this an
   image" cheaply, carry a medium marker in our own `content_type`/metadata.
7. **Spine flattens to `strand → expectation`.** The subtopic/`Chapitre` moves
   wholesale into the content layer as a `LessonGrouping`. *Assumption to confirm:* the
   subtopic carried only book structure, no independent standards meaning; any that did
   stays on the spine.

### Prose lives in `Material.content` (hybrid)

Confirmed by the LC schema: neither `Lesson` nor `Activity` has a rich body field
(`Lesson` has only a short `description`). Load-bearing prose has exactly one home —
**`Material.content`** (String, HTML-encoded, required) — attached by `hasPart`. So
the hybrid rule becomes concrete: substantive content is stored as `Material` nodes;
structural nodes carry metadata; the render prompt assembles them and phrases only
connective tissue. What a curator approves in `diff_draft` / `preview` is what ships.

Concrete split for an addition lesson:

| Stored (approved, diffable) | Generated at render |
|---|---|
| `Lesson`: objective (via alignment), `timeRequired`, `audience` | Section intros, transitions |
| `Material` (scene): `content` = image HTML for "market stall, mangoes in piles of 8 and 5", `materialType` = Core | Framing sentences around the scene |
| `Activity`: `studentGroupingType`, `timeRequired`, + `Material.content` = the steps and the specific numbers | Teacher-voice phrasing of each step |
| `LessonGrouping`: `groupName`, `groupLevel` | Chapter heading (or omitted) |

Rule of thumb: **anything a curator would want to review, diff, or approve is stored**
(a `Material.content` or a structural property); the render invents nothing
load-bearing.

## Node & edge inventory (real LC vocabulary)

Content-layer node types and the fields we would populate. Every node also needs LC's
required boilerplate: `attributionStatement`, `author`, `license`, `identifier`,
`audience`, `providerDateCreated`, `providerDateModified`.

- **`Course`** — top of the content tree.
- **`LessonGrouping`** (= chapter) — `groupName` (label), `groupLevel` (required
  position in series), `position`, `ordinalName`, `name`, `description`.
- **`Lesson`** — `name`, `description` (short summary only), `timeRequired`,
  `position`, `educationalUse`, `isOptional`.
- **`Activity`** — `name`, `educationalUse` + `audience` (prescriptive vs
  illustrative), `studentGroupingType` (individual/pairs/group), `timeRequired`,
  `position`, `isOptional`, `gradingRequired`, `submissionRequired`.
- **`Material`** — `content` (required, HTML — the actual prose or image markup),
  `material_type` (required — `Core` | `Supporting` | `Reference`, i.e. centrality),
  `name`, `educational_use`. Medium (image vs text) lives in `content`, optionally
  mirrored in our `content_type`. *Note: LC marks `Material` "gated"
  (approval-controlled) — worth confirming access.*

Edges (all real LC types):

- `Course —hasPart→ LessonGrouping —hasPart→ Lesson` (LessonGrouping may nest via
  `hasPart → LessonGrouping`).
- `Lesson —hasPart→ Activity`, `Lesson —hasPart→ Material`, `Activity —hasPart→ Material`.
- `Lesson —hasEducationalAlignment→ StandardsFrameworkItem` (coverage). `Activity`,
  `LessonGrouping`, and `Material` may also align.
- `Activity —hasReference→ Lesson`, `Lesson —usesRoutine→ InstructionalRoutine`, etc.
  — available if useful; not required for v1.
- Reuse of the RECE exemplars: link authored activities to illustrative ones via
  `hasReference`/`hasDependency` (optional).

## The two prompts

1. **Author** — per (grade, subject): a prompt driving content recipes that mutate the
   graph (add lesson, add chapter, add activity, add material/image, set fields, align
   to expectation).
2. **Render** — a prompt that generates the guide / student book *from* the extended
   graph, assembling `Material.content` + structural metadata into prose per the hybrid
   rule.

## Recipes

Two distinct families — keep them from colliding (both have things called "lesson"):

- **Standards recipes (exist, renamed):** today's `add_lesson` / `add_chapter` create
  *spine* nodes (`StandardsFrameworkItem`). Post-split they become "add expectation" /
  "add strand".
- **Content recipes (new):** `add_lesson`, `add_lesson_grouping` (LessonGrouping, with a `groupName` type — Chapitre/Unité/Module),
  `add_activity`, `add_material` (incl. image), `set_material_content`,
  `align_to_expectation`, plus `move_lesson` / `renumber` re-scoped to editorial
  groupings only.

All ride the existing two-phase `runGraphMutation` (dry-run → diff + token → confirm →
draft), inheriting draft/publish, `diff_draft`, `preview_generation`, and audit.

## Migration (maths first; done on the draft, self-validating)

The current 1:1 makes this a mechanical, deterministic transform:

1. `createDraft` (snapshot published byte-for-byte).
2. Each subtopic/`Chapitre` → mint a content `LessonGrouping`, carry title → `groupName`,
   order → `groupLevel`/`position`.
3. Each expectation/lesson → **keep** the expectation on the spine (OS text stays);
   **mint** a `Lesson` node; move the teaching text into an attached `Material.content`;
   add `Lesson —hasEducationalAlignment→ Expectation` and `LessonGrouping —hasPart→
   Lesson`.
4. Leave the RECE illustrative `Activity` nodes as-is; optionally `hasReference`-link
   them from the new lessons.
5. Update the adapter read path (`labelToKind` / `roleToKind`, `buildSlice`,
   `lessonsOf`, `weekMap`) to read lesson/chapter/material from the content layer and
   expectation/coverage from the spine.

**Acceptance test (the safety net):** a generated guide for a chapter must render
**byte-identical before and after** the migration. Because the transform is lossless
1:1, any drift in `preview_generation` means the split lost something — caught before
`publish_draft`. Then update `sources/` to match and re-seed (`seed:kg-store`) so
`parity:kg-store` and `faithful-reexport` stay green, and publish.

## Adapter impact

The adapter thins but does not disappear. Parse becomes content-driven for
lesson/chapter/material; `recipeProfile` gains the content family; `lcNodeTemplate`
gains content-layer stamps (Lesson/LessonGrouping/Activity/Material) distinct from the
spine stamps. Because *we* control the shape of what these recipes create, the content
layer can be **subject-uniform** even while the imported spines still differ — the
practical mechanism for the maths↔reading convergence. Deliverables, prompts, and spine
coverage rules still need a home. Fewer, thinner adapters — not none.

## CE1 reading

Reading has **no content layer today** (0 `Curriculum` nodes; content sits in
`LearningComponent`s, spine week/strand). Authoring for reading builds the content
layer from scratch, and chapters may simply not exist there — fine, since chapters are
optional. End state: both subjects share the same content-layer shape.

## Open questions / risks

1. **Serialization gap — DECIDED: match the existing graph's convention.** New content
   uses `Curriculum`/`normalized_type`, `hasChild`/`supports`, snake_case (see
   *Representation convention* above). "Faithful re-export" continues to mean
   reproducing our simplified serialization; full canonical-LC alignment (camelCase,
   `hasPart`/`hasEducationalAlignment`) is out of scope for this work and would be its
   own later initiative.
2. **Controlled-vocab values — RESOLVED.** `EducationalUseENUM` = `Instruction` |
   `Assessment` (teach vs test → our bilan axis, decision 5); `MaterialTypeENUM` =
   `Core` | `Supporting` | `Reference` (centrality, not medium, decision 6). Neither
   encodes prescriptive-vs-illustrative (positional) or image-vs-text (in `content`).
3. **`Material` is gated** in LC (approval-controlled) — confirm this has no licensing
   or access implication for how we store/emit material content.
4. **Subtopic semantics** — confirm no subtopic carries independent standards meaning
   (decision 7).
5. **Reading's lesson grain** — RESOLVED for Scope A (one Lesson per language-tool
   standard per week). The fuller session model is *Scope B* below.
6. **Rendered `.docx` repositioning.** `create_upload_url` / `log_generation` /
   `record_document_content` write live today. Under this model the `.docx` becomes a
   downstream *render* of published graph content that must trace back to a published
   graph version.

## Scope B — reading's weekly session timetable (planned, not started)

> **Status: Planned.** Scope A (above) gave reading a content layer with one Lesson
> per language-tool standard per week, reads byte-identical. Scope B is the larger,
> not-yet-started follow-on.

**Problem.** A reading week's teacher guide is **22 daily sessions across 5 days**
(oral, comprehension L1/L2, the six language tools, recitation/poetry, production,
writing, remediation). That timetable is **hardcoded in the generation prompt**
(`sources/ce1/reading/PROMPT_generate_lessons.md`, ~lines 94–112), NOT in the graph —
the graph carries only the per-skill standards. So the real teaching structure isn't
graph-native; Scope A surfaces only the 6 language-tool objectives.

**Goal.** Move the sessions into the graph as content `Lesson` nodes (one per
session) so the graph is the single source of truth, and rewrite the prompt to read
sessions from `get_curriculum` instead of hardcoding them.

**This is deliberately NOT byte-identical** (unlike Scope A / the maths split): it
**changes reading's read projection** (from `languageToolStandards` to a per-week
**session list**) **and the generation prompt**. It subsumes Scope A's 6 lessons (they
become a subset of the 22 sessions). A session `Lesson` carries: day (Jour 1–5), order,
session type (L1/L2 title), language (L1 / L2 / parité), duration, and a session
category (oral / comprehension / language-tool / production / poetry / writing /
remediation); it `supports` the standard it teaches where one exists (many sessions →
one standard; Remédiation may have none). The week stays a `LessonGrouping`.

**It's an authoring/extraction task, not a mechanical migration.** The session
structure lives in the prompt's canonical table + the authored weeks 1–8 exemplars (in
Storage, via `list_documents` / `get_document_text`); sessions must be created and
aligned to existing standards, following the curriculum tool where a week diverges.

**Recommended first step:** build the **22-session → week-attached-standard mapping**
(which sessions align to a standard, which don't, the many-to-one shape). It decides the
node schema and shows how many of reading's currently-"non-spine" components are
teachable sessions vs. deeper scaffolding.

**Open decisions (confirm before coding):** (1) session→standard alignment + no-standard
sessions; (2) session node schema in the existing convention (day/language/duration/type
as raw metadata + normalized order; `timeRequired`/`educational_use`); (3) day as a Lesson
attribute vs. a nested per-day grouping; (4) the new `buildSlice` session shape; (5) how
much of the prompt's table moves to `get_curriculum` (the riskiest part — the guide is
finely tuned); (6) integration/evaluation weeks (9/17/24/25).

**Method:** same pattern — deterministic authoring script; a golden gate **regenerated to
the new shape** (review the diff, not byte-identical); update `READING_PARSE` + `buildSlice`
+ the reading prompt; fix faithful-reexport counts / parse-graph checkpoint / explorer;
build + tests green; branch → PR → merge → re-seed. The prompt rewrite is the highest-risk
piece — the guide's pedagogical quality is the acceptance bar beyond the tests.
