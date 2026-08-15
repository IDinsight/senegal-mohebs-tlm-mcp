# Graph-native authoring — target model & migration plan

> **Status: Current — implemented and live.** Landed for CI maths via PR #28
> (split + authoring/edit surface) and PR #29 (bilan as data), both merged; the
> Firestore store has been re-seeded (ci/maths was 509 nodes / 885 edges at the split;
> now **501 / 877** after the canonical migration + the RECE / illustrative-activity
> cleanups below). The migration is reproducible via `scripts/migrate-maths-graph.mjs`. CE1 reading now has the
> content layer too (Scope A — one Lesson per language-tool standard per week;
> `scripts/migrate-reading-graph.mjs`; reads byte-identical). **Scope B** then made
> reading's full **22-session daily timetable** graph-native — one content `Lesson`
> per session, aligned to the standard it teaches (`scripts/migrate-reading-graph-scope-b.mjs`);
> sessions were later nested under **`Jour 1–5` day `LessonGrouping`s**
> (`scripts/migrate-reading-day-groupings.mjs`; ce1/reading now **1968 nodes / 2244 edges**).
> The read projection is a per-week session
> list and the generation prompt reads it from `get_generation_context` instead of a hardcoded
> table. **Scope B merged** (PR #34), re-seeded, and deployed to Cloud Run.
> **Scope C** (activities & materials *inside* a lesson) is **in progress** — Increment 1
> (reading's scoped recipe surface + per-recipe availability) merged (PR #36); Increment 2
> (`add_activity` / `add_material` / `set_material_content` recipes + read projection +
> prompt) built (this PR — machinery only; the bulk authoring of reading's sessions is a
> later pass). See the Scope C section below. LC type/edge vocabulary confirmed against
> the [LC Curriculum reference](https://docs.learningcommons.org/knowledge-graph/graph-reference/curriculum)
> (Activity, Material, Lesson, LessonGrouping). The project now uses **canonical LC
> at rest** (camelCase, `hasPart`/`hasEducationalAlignment`); the *Representation
> convention* section below is superseded — see
> [canonical-lc-migration.md](canonical-lc-migration.md).

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

## Representation convention (SUPERSEDED — now canonical LC)

> **Superseded.** This section described the original *simplified serialization*. The
> store, parser, adapters, and re-export now speak **canonical Learning Commons** at rest
> — see [canonical-lc-migration.md](canonical-lc-migration.md). The mapping table below is
> kept only to read the pre-migration history; wherever this note says `hasChild` for
> content containment, `supports` for lesson→standard alignment, `Curriculum`+`normalized_type`,
> or snake_case, read it as `hasPart`, `hasEducationalAlignment`, real `Activity`/`Course`
> labels, and camelCase respectively.

New authored content originally used **the graph's existing serialization**, not the
canonical LC schema — internal consistency and a simpler migration, at the cost that
"faithful re-export" meant "reproduces our simplified serialization." The canonical
LC names used throughout this note mapped onto what we then wrote as follows:

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
                                            IllustrativeTask = an Activity that
                                            `hasEducationalAlignment`s a standard and
                                            carries `metadata.illustratesComponent`;
                                            the RECE + six "Composants dérivés" frames
                                            hold these as an authoring input.
```

> **Update (post-canonical):** RECE was normalized to match the other "Composants
> dérivés" frames — the illustrative-task `Course` wrapper was removed and its
> activities re-homed directly under the frame's sub-SFIs. And illustrative
> activities now `hasEducationalAlignment` a **standard** (canonical), carrying the
> specific component in `metadata.illustratesComponent` — there is no
> Activity↔LearningComponent edge. See *Decision 5* below (updated) and
> [canonical-lc-migration.md](canonical-lc-migration.md).

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
   authored **prescriptive** activity is a `hasPart` of a `Lesson` (part of the teaching
   sequence); an **illustrative** task lives under a "Composants dérivés" frame SFI and
   `hasEducationalAlignment`s a **standard** (its component's parent SFI — canonical LC
   has no Activity↔LearningComponent edge), carrying the specific component it exemplifies
   in `metadata.illustratesComponent = {id, name, order}` and a `contentType`
   ("Tâche illustrative (…)"). So the test is "is it a `hasPart` child of a Lesson?"
   (prescriptive) vs "does it align to a standard from a derived frame?" (illustrative).
   Separately, `educationalUse` gives us a clean home for the **bilan / assessment**
   axis: `educationalUse: Assessment` for assessment content, `Instruction` for teaching
   content (replaces the ad-hoc `isAssessment`).
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

1. **Serialization gap — ~~DECIDED: match the existing graph's convention~~ → REVERSED.**
   Originally we chose the simplified serialization (`Curriculum`/`normalized_type`,
   `hasChild`/`supports`, snake_case; see *Representation convention* above), deferring
   canonical-LC alignment as "its own later initiative." That initiative is now **on**:
   the store, parser, adapters, and re-export are moving to **canonical LC at rest** —
   see [canonical-lc-migration.md](canonical-lc-migration.md), sequenced **before Scope C**.
   The *Representation convention* table above describes the pre-migration state and will
   be retired once canonical lands.
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

## Scope B — reading's weekly session timetable (implemented, re-seed pending)

> **Status: Implemented on a branch; re-seed pending.** Scope A (above) gave reading
> a content layer with one Lesson per language-tool standard per week, reads
> byte-identical. Scope B is the larger follow-on: it makes the full daily timetable
> graph-native. Migration `scripts/migrate-reading-graph-scope-b.mjs`; read projection
> in `src/adapters/ce1-reading.ts`; prompt in `sources/ce1/reading/PROMPT_generate_lessons.md`.
>
> **Decisions taken** (confirmed before coding):
> 1. *Alignment gap* — attach existing standards, keep gaps honest. Each session
>    `supports` the standard it teaches; weeks 1–8 oral/comprehension/poetry sessions
>    align to the **shared palier-1 combined standards** (the pre-existing `"1 à 8"`
>    grouping's Expression orale / Lecture / Récitation nodes), so the only genuinely
>    standard-less session is **Remédiation** — a first-class coverage gap, not invented
>    spine. (The feared "weeks 1–8 have no oral standards" turned out false: they exist
>    as one combined node each.)
> 2. *Session schema* — flat: 22 `Lesson` nodes directly under the week's
>    `LessonGrouping`; day / order-in-day / global session order / language / duration /
>    session category as snake_case `metadata`, plus `time_required` + `educational_use`.
>    No per-day grouping layer.
> 3. *Prompt scope* — sessions + alignment move into the graph; the pedagogy (phase
>    spines, density floor, bilingual conventions, formatting) stays in the prompt. The
>    prompt now reads `sessions` from `get_generation_context` and produces exactly those.
>
> **Outcome:** 462 session Lessons (22 × 21 guide weeks), 441 `supports` alignments,
> 0 unresolved. Read projection replaced `languageToolStandards` with a `sessions`
> list; golden gate regenerated (reviewed diff, not byte-identical — by design);
> faithful-reexport / parse-graph checkpoint / explorer counts updated; build + all
> tests green. **Remaining:** re-seed Firestore (`seed:kg-store`) + deploy.

**Problem.** A reading week's teacher guide is **22 daily sessions across 5 days**
(oral, comprehension L1/L2, the six language tools, recitation/poetry, production,
writing, remediation). That timetable is **hardcoded in the generation prompt**
(`sources/ce1/reading/PROMPT_generate_lessons.md`, ~lines 94–112), NOT in the graph —
the graph carries only the per-skill standards. So the real teaching structure isn't
graph-native; Scope A surfaces only the 6 language-tool objectives.

**Goal.** Move the sessions into the graph as content `Lesson` nodes (one per
session) so the graph is the single source of truth, and rewrite the prompt to read
sessions from `get_generation_context` instead of hardcoding them.

**This is deliberately NOT byte-identical** (unlike Scope A / the maths split): it
**changes reading's read projection** (from `languageToolStandards` to a per-week
**session list**) **and the generation prompt**. It subsumes Scope A's 6 lessons (they
become a subset of the 22 sessions). A session `Lesson` carries: day (Jour 1–5), order,
session type (L1/L2 title), language (L1 / L2 / parité), duration, and a session
category (oral / comprehension / language-tool / production / poetry / writing /
remediation); it `hasEducationalAlignment`s the standard it teaches where one exists
(many sessions → one standard; Remédiation may have none). The week stays a
`LessonGrouping`.

> **Refinement (later):** sessions are no longer direct children of the week. Each
> week now holds **`Jour 1–5` day `LessonGrouping`s** (kind `day`, `groupName "Jour"`),
> and the sessions hang under their day (`week → day → session`;
> `scripts/migrate-reading-day-groupings.mjs`). The read projection is unchanged —
> `buildSlice` gathers sessions across the days and sorts by `session_order` — so the
> golden gate stayed green; `get_generation_context`'s session list is still flat (each session
> carries its `jour`).

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
much of the prompt's table moves to `get_generation_context` (the riskiest part — the guide is
finely tuned); (6) integration/evaluation weeks (9/17/24/25).

**Method:** same pattern — deterministic authoring script; a golden gate **regenerated to
the new shape** (review the diff, not byte-identical); update `READING_PARSE` + `buildSlice`
+ the reading prompt; fix faithful-reexport counts / parse-graph checkpoint / explorer;
build + tests green; branch → PR → merge → re-seed. The prompt rewrite is the highest-risk
piece — the guide's pedagogical quality is the acceptance bar beyond the tests.

## Scope C — activities & materials inside a lesson (in progress)

> **Status: In progress — content machinery built; bulk authoring pending.**
>
> **⚠️ Superseded surface:** the named content recipes described below (`add_activity` /
> `add_material` / `set_material_content`) have been **replaced by four GENERIC verbs** in
> the `kg-recipes` module — `add_node` / `move_node` / `reposition` / `set_content` — which
> also replaced the old maths recipes (`add_lesson` / `add_lesson_grouping` / `move_lesson` /
> `renumber`; `split_lesson_grouping` was dropped). The verbs speak **pure canonical LC** and
> carry **no `RecipeProfile`**: `add_node(parentId, label, …)` derives the created node's
> identity skeleton (labels, normalized type, role, raw ordinal path(s)) by **copying an
> existing node of that label from the graph** (canonical defaults for the first of a kind).
> An adapter no longer declares `recipeProfile` / `structuralAliases` / `lcNodeTemplate` /
> `availableRecipes`; per-subject recipe gating is gone (validity is structural). The
> conceptual model below (phase-grained Activities, Material.content, the hybrid rule, the
> read projection, alignment default-off) is unchanged — only the *tool surface* generalized.
> Reading a session's authored content: `add_node` with `label:"Activity"` / `"Material"`
> (+ `properties.content`) and `set_content`; `buildSlice` surfacing is identical. See the
> `kg-recipes/` module + `docs/design-notes/kg-mutations/`.
>
> **Decisions confirmed:** (1) **grain = phase-grained** — one `Activity` per phase
> (Étape), its scripted teacher/pupil content stored as that activity's `Material.content`;
> (2) **recipe scope = per-recipe availability** — recipes gained a per-subject allowlist
> (`SubjectAdapter.availableRecipes`), so reading opts into only the recipes that fit and
> **not** week-level `split`/`renumber`; (3) reading now reads its week number from the
> canonical **`position`** (`numberFrom: "position"`), retiring the bare-number-`description`
> reliance; (4) **a `Material` may hang off any container level** — an `Activity` (an Étape's
> script), a `Lesson` (session-level, e.g. the shared *Jukki*), **or** a `LessonGrouping` (a
> week/chapter, e.g. an opening-scene image) — all via `hasPart`; (5) **content is edited
> only** by `add_material` / `set_material_content` (a `Material`'s `content` is deliberately
> **not** a `wordingAlias`, so `upsert_property` can't reach load-bearing content — see
> `MATERIAL_CONTENT_PATH`); (6) **activity alignment = default off** — an `Activity` inherits
> its lesson's standard, so `add_activity` writes **no** alignment edge.
> **Increment 1 (done):** reading recipe surface — `recipeProfile` (canonical
> `hasPart`/`hasEducationalAlignment`, `activityKind`/`materialKind`), `structuralAliases`,
> `lcNodeTemplate` (week/lesson/activity/material); parser `numberFrom: "position"`;
> `Activity`/`Material` parse kinds; per-recipe gating in `server/recipes.ts` + the
> `get_capabilities` mirror. **Increment 2 (built — this PR, machinery only):** the
> `add_activity` / `add_material` / `set_material_content` recipes (`kg-store/recipes/*`,
> registry + three MCP tools), `postParse` keeping the content layer, `buildSlice` surfacing
> each session's `activities` (+ their `materials`) plus session-/week-level `materials`, the
> prompt rendering authored content when present (else composing freely),
> `availableRecipes: ["move_lesson", "add_activity", "add_material", "set_material_content"]`.
> Golden **regenerated** (additive: new empty `activities`/`materials` arrays — every
> existing value byte-identical); build + all tests green (+ `ce1-reading.scope-c.test.ts`).
> The **bulk authoring** of reading's sessions (a deterministic first-pass seed derived from
> each session's components) is a **separate later pass** — until it runs, real sessions read
> back with empty `activities`. Builds directly on Scope B. Scope B made the
> *lessons* (the 22 daily sessions) graph-native; Scope C makes what a lesson
> *contains* — its teaching **Activities** and their **Materials** — graph-native too,
> so the load-bearing content is authored, reviewable (`diff_draft` / `preview`), and
> stable, instead of being regenerated freeform into the `.docx` on every run. This is
> the `Lesson → Activity → Material` layer from *Target model* above, finally built.

**The parallel that motivates it.** The standards side and the content side share a
tier one level down, and they line up:

```
STANDARDS side                              CONTENT side
  StandardsFrameworkItem                      Lesson
     ▲                                           │
     │ (LearningComponent → SFI)                 │ (Lesson → Activity)
  LearningComponent  ── same tier ──          Activity ──► Material
   "what to learn" (a skill)                  "what you do" (a task) + its content
```

A standard is *decomposed* into LearningComponents; a lesson is *composed* of
Activities. So the standard a session teaches already names the skills to cover (its
components) — and those components are the natural **seed** for that session's
activities.

**Edges — now canonical LC directly.** The project moved to **canonical LC at rest**
([canonical-lc-migration.md](canonical-lc-migration.md)), so Scope C uses the canonical
edges as-is (the old "our serialization" column is retired):

| relationship | edge |
|---|---|
| Lesson / Activity → standard (alignment) | `hasEducationalAlignment` → `StandardsFrameworkItem` |
| LearningComponent → standard | `supports` → `StandardsFrameworkItem` |
| Course/LessonGrouping → Lesson, Lesson → Activity, Activity → Material (containment) | `hasPart` |

One consequence worth stating flatly: alignment (`hasEducationalAlignment`) can only
target a `StandardsFrameworkItem`, **never a `LearningComponent`** — there is no
Lesson↔LearningComponent nor Activity↔LearningComponent edge in LC. So a component is a
*generation input*, not an edge target; where an activity must record the specific
component it exemplifies, that rides in `metadata.illustratesComponent` (see the
post-canonical cleanups in [canonical-lc-migration.md](canonical-lc-migration.md)).

**What Scope C stores (the hybrid rule).** Per *Prose lives in `Material.content`*: the
reviewable, load-bearing content is stored; the render phrases only connective tissue.
- **`Activity`** — a task node under a Lesson (`hasPart`): `studentGroupingType`
  (individual / pairs / group), `timeRequired`, `position`, `educationalUse`
  (Instruction / Assessment). *Prescriptive* by position — a `hasPart` of the Lesson —
  per *Decision 5* (as opposed to illustrative tasks, which live under a "Composants
  dérivés" frame and `hasEducationalAlignment` a standard + carry
  `metadata.illustratesComponent`).
- **`Material`** — the actual prose / steps / numbers (and image briefs) as `content`
  (HTML), with `materialType` (Core / Supporting / Reference), attached to its Activity
  (or Lesson) by `hasPart`.

**Derivation is a generation aid, not a stored edge.** The author flow reads a
session's standard + its LearningComponents and *derives* candidate activities (one
component often → several activities; several sessions share one standard's components,
so derivation is per-*(session, standard)*). The curator reviews/edits; then
`add_activity` / `add_material` persist the approved result. No component→activity edge
is written (LC defines none).

**Open decisions — now resolved (Increment 2).**
1. **Store-vs-render grain** — ✅ **phase-grained**: each *Étape* is one `Activity`; its
   scripted teacher/pupil content is that activity's `Material.content` (not one Activity
   per teacher move). Sets node volume at ~one per phase.
2. **Reading needs a recipe surface** — ✅ **done in Increment 1** (PR #36): reading now
   declares a `recipeProfile` + `structuralAliases` + `lcNodeTemplate` (week/lesson/activity/
   material stamps) + `availableRecipes`, and the parser gained `Activity`/`Material` kinds.
3. **New recipes** — ✅ **`add_activity` / `add_material` / `set_material_content`** built
   (Increment 2). `add_activity` puts an Activity under a Lesson via `hasPart`;
   `add_material` puts a Material `content` under an **Activity, Lesson, OR LessonGrouping**
   (any container level); `set_material_content` rewrites an existing Material's content —
   the only content-edit verb, since `content` is **not** a `wordingAlias` and `upsert_property`
   can't reach it. All ride the existing two-phase `runGraphMutation` (dry-run → diff + token
   → confirm → draft), inheriting draft/publish, `diff_draft`, `preview_generation`, audit,
   and per-recipe availability. `move_activity` / activity `renumber` were **not** built —
   editorial reordering is deferred until authored content exists to reorder.
4. **Activity-level alignment** — ✅ **default off**: the Lesson already aligns to the
   standard, so activities inherit coverage; `add_activity` writes **no** alignment edge. An
   `Activity —hasEducationalAlignment→ SFI` for a finer/different standard is a future,
   explicit step. Keeps coverage simple.
5. **Read projection** — ✅ `buildSlice` now includes each session's `activities`
   (+ their `materials`) plus session- and week-level `materials`; `postParse` keeps the
   content layer under kept lessons/weeks; the golden gate was **regenerated** (additive
   only — new empty arrays; every existing value byte-identical).
6. **Reading vs maths** — reading has **0** Activities (Scope C authors them); maths has
   **104** illustrative `Activity`s (label `Activity`) under its "Composants dérivés"
   frames, each `hasEducationalAlignment`-ing a standard + carrying
   `metadata.illustratesComponent`. The prescriptive (`hasPart` of a Lesson) vs.
   illustrative (aligned to a derived-frame standard) split holds for both; reading
   activities may optionally `hasReference` maths-style exemplars.
7. **`.docx` repositioning** (Open Question #6) — the guide becomes a render of the
   stored activities/materials, traceable to a published graph version.

**Method.** Unlike Scope A/B this is mostly **new authored content** (reading has no
activities to migrate), so it is an authoring task — likely a deterministic seeding
script that derives a first pass from the components, then curator review via the new
recipes — not a mechanical migration. Golden gate regenerated; `add_activity` /
`add_material` covered by mutation tests + the `get_capabilities` mirror; build + tests
green; branch → PR → re-seed. **Acceptance bar: the generated guide's pedagogical
quality is preserved or improved, and what a curator approves in `diff_draft` /
`preview` is what ships.**

## Batched authoring + generic reads (live)

**Status: live.** Bulk authoring (seed a subtree of many nodes, then wire many edges)
made the one-at-a-time flow painful — 88 `StandardsFrameworkItem`s plus 84 alignment
edges was ~350 round-trips. Two batched write tools and two generic read tools address
that; all four preserve namespace scoping and (writes) the two-phase confirm contract.

**Reads.**

- **`walk_graph(fromId, direction, edgeTypes?, nodeTypes?, maxDepth?, includeEdges?, limit?, cursor?, slot?)`**
  — one directional (`out`/`in`/`both`), edge- and label-filtered, paginated BFS over the
  echoed raw graph. It is the single generic traversal and **replaced `get_course`** (which
  blew the token cap on any non-trivial course): a course subtree is `walk_graph(course,
  "out", ["hasPart","hasChild","usesRoutine"])`; the framework root is `walk_graph(<any
  SFI>, "in", ["hasChild"], ["StandardsFramework"])`. Non-matching nodes are traversed
  *through*, so `nodeTypes` composes with the walk. Pagination is stateless (a
  deterministic re-run sliced by an opaque `(depth,id)` cursor, like `read_audit`).
  `slot:"draft"` walks the unpublished draft (curator/approver only, same tier as
  `diff_draft`), closing the gap `get_course`'s removal left. Reader: `curriculum/walk.ts`.
- **`namespace_stats()`** — an argument-free orientation snapshot: node counts by label,
  edge counts by type, structural roots (no inbound `hasPart`/`hasChild`), draft state
  (open + staged-edit count), and cheap heuristic `coverageFlags`. Run it first to see the
  shape of a namespace before writing a walk. Reader: `curriculum/stats.ts`.

**Writes (batched).** Both fold the single-item verb over one accumulating graph, so the
whole batch is **one** `runGraphMutation` → one diff → one confirmation token → one `apply`
audit record (the `useRoutine` shape). Any item error blocks the whole batch — no partial
apply.

- **`add_nodes(items[], …)`** — the batch form of the typed adds. Each item attaches under
  an **existing** parent (intra-batch parents are deferred to a future composite recipe);
  ids are minted per item and returned so a follow-up `create_edges` can wire them. Recipe:
  `kg-recipes/add-nodes.ts`.
- **`create_edges(edges[], …)`** — the batch form of `create_edge`. Duplicate detection
  spans both the batch and the current draft. Recipe: `kg-recipes/create-edges.ts`.

`get_capabilities` advertises all four (batched writes under `editable.batch` /
`editable.structural.verbs`; the reads under a new `discovery` block).

### Payload shape + idempotency (follow-on, live)

An 84-SFI + 84-edge batch on `senegal/ci/maths` surfaced three friction points — all
payload-shape / idempotency, not new capability:

- **`returnMode: "summary" | "full"`** on `add_nodes` / `create_edges`, default **`"summary"`**.
  The full diff of an 84-item batch is ~200 KB, forcing callers to save-and-grep just for the
  token + minted ids. `"summary"` drops `diff` and returns a compact `counts`
  `{ nodesAdded, edgesAdded, nodesChanged, nodesRemoved, edgesRemoved }` (~1 KB); `"full"`
  keeps the diff alongside `counts`. Applied on both dry-run and confirm. Storage/audit
  unchanged. **Breaking** for callers that parsed `diff` off the response. Shaping lives in
  `server/batch.ts`.
  - **Extended to `publish_draft` / `discard_draft`** (a later 252-edit draft on the same
    namespace showed their dry-runs echo the *whole-draft* diff — even larger — and blow the
    same cap, so callers couldn't extract the `confirmationToken`). Same `returnMode` param,
    same `"summary"` default, same `counts` contract (reusing `batch.ts`'s `countsOf`); shaping
    lives in `server/lifecycle.ts`. `warnings` are kept **verbatim in both modes** — coverage
    flags are load-bearing for an approver before promoting. The staged `profileDiff` is dropped
    in summary like the graph diff (the "(includes a subject-profile change)" note stays on the
    action/message). The commit results were already diff-free, so only the dry-run changed.
    `diff_draft` remains the endpoint for the full diff on demand. **Breaking** for callers that
    parsed `diff` off a publish/discard response. Advertised in `get_capabilities` under
    `lifecycle`.
- **`walk_graph` default `limit` 50** (was 100; ceiling still 500). A framework-root walk of
  156 SFIs blew the token cap on the old default. Pagination is the expected path — the
  response always carries `nextCursor` plus two independent flags: **`truncatedByLimit`** (the
  page limit cut this response — page on) vs **`truncated`** (the `maxDepth` cap hid deeper
  nodes).
- **`idempotencyKey`** on `add_nodes` / `create_edges`. A retried confirm with the same key +
  same payload replays the first apply's summary (`replayed: true`) instead of `REPLAY` — no
  double-apply, no double-audit. Same key + different payload → `IDEMPOTENCY_KEY_MISMATCH`
  with the original summary attached. Keys are **namespace-scoped**, expire after **24h**, and
  are process-scoped (a restart falls back to the base-hash CAS, which still blocks any
  double-apply via `STALE_TOKEN`). Kept in `server/idempotency.ts` — not kg-store — because
  the stored summary is tool-layer data (minted ids, the apply's `auditId`) the framework
  never sees. Omit the key for strict single-use tokens (unchanged behaviour).

The two-phase contract was audited in the same pass: the framework's preview branch computes
the diff purely in memory and never calls `writeSlot`/`createDraft` — only confirm writes — so
a dry-run stages nothing (guarded by a `namespace_stats.draft` before/after test).
