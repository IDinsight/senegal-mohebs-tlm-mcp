# Multi-subject architecture — design doc

> **Status: Current.** The adapter architecture described here is live. Some pre-convergence details are flagged HISTORICAL inline (see the update note below). Also POST-SPLIT: CI maths is now **graph-native** — a lesson is a content `Lesson` node that `supports` its spine `expectation` (lesson ≠ objective), and a chapter is a content `LessonGrouping`; the read projection reflects this. The one-generic-parser design here is unchanged (roles AND labels map to kinds). See [`graph-native-authoring.md`](graph-native-authoring.md) for the current maths model.

> **Update (maths↔reading convergence):** both subjects now share the `{ nodes, relationships }` envelope + LC metadata scheme and parse through one generic `curriculum/parse-graph.ts::parseGraph` (a thin per-subject descriptor). References below to CI maths's `graph[]` envelope and the denormalized `chapitreNum` chapter↔lesson join are HISTORICAL — chapter↔lesson is now the `hasChild` edge. See CLAUDE.md for the current shape.

**Status:** proposal · **Scope:** how the server supports more than one grade/subject
whose curriculum graphs and deliverables differ · **Last updated:** 2026-07-21

## 1. Purpose

The server began as a CI-mathematics tool. It has since been renamed
(`senegal-mohebs-tlm-server`) and gained a runtime *teaching context* — a
`(grade, subject)` pair chosen with `set_context`, backing per-context source
files under `sources/<grade>/<subject>/` and per-context storage under
`<grade>/<subject>/` in the bucket. That work isolates **data** per context.

It does **not** isolate **behavior**. The parsing and generation logic is still
written to the CI-maths curriculum graph and the CI-maths deliverable set. This
doc specifies the seam that lets a new grade/subject plug in its own graph
parsing and its own set of documents without rewriting the core each time.

The trigger is concrete: we now have a second real curriculum graph (CE1
reading), and it differs from CI maths at every structural level. We are no longer
designing against a guess.

## 2. What we learned from two real graphs

Two graphs, two genuinely different architectures — not a renamed schema.

| Assumption in `curriculum/knowledge-graph.ts` | CI maths | CE1 reading |
|---|---|---|
| Envelope | one `graph:[]`, elements tagged `type:"node"\|"relationship"` | two arrays: `nodes:[]` + `relationships:[]` |
| Node id | `identifier` | `id` (+ `properties.identifier`, `case_identifier_uuid`) |
| Relationship fields | `label`, `source_identifier`, `target_identifier` | `type`, `start`, `end` (endpoints keyed differently) |
| "Chapter" marker | `statementType === "Chapitre"` | none; `statement_type` (snake_case), ~25 open values |
| Chapter→lesson link | shared property (`chapitreNum` match) | edge tree (`hasChild`, single root, ≥4 levels) |
| Ordering | integer `leconNum` | tree position / Paliers; no numbering |
| Task tier | `Curriculum` nodes via `supports` | none |
| Progression | `buildsTowards` edges | `hasChild` / `relatesTo` |

The decisive point: the two graphs use a **different mechanism** for hierarchy.
CI maths encodes chapter membership as a *property on the node*; CE1 reading encodes it
as a *tree of edges*. There is no "chapter" or "lesson" to rename — the CE1 reading
spine is `Framework → section → substage (Palier) → competency grouping →
skill-area`, with learning components hanging off the leaves. A profile that only
remapped field *names* would not survive this file.

The deliverable set differs too:

| | CI maths | CE1 reading | headroom |
|---|---|---|---|
| # deliverables | 2 | 1 | must be open-ended |
| Types | student book (`manual`) + teacher guide (`lessons`) | standalone teaching guide | new types addable later |
| Dependency | teacher guide builds on the student book | none (standalone) | dependency is per-type, sometimes empty |
| Scoping unit | per chapter | per Palier / skill-area / whole subject (open — see §9) | per-type |

## 3. Three axes of variation

Everything subject-specific falls on one of three independent axes. A subject can
differ on any one while matching on the others, so they must be separate knobs.

1. **Graph structure** — envelope format, node/relationship taxonomy, and the
   hierarchy mechanism. *Today:* hardwired in `curriculum/knowledge-graph.ts`.
2. **Deliverable set** — which documents exist, and how an uploaded file is
   recognized as one of them. *Today:* `DocType = "manual" | "lessons"` in
   `types.ts` + `classify()` in `storage/documents.ts`.
3. **Deliverable ↔ curriculum mapping** — the curriculum unit each deliverable is
   scoped to, and the dependencies between deliverables. *Today:* the
   `${chapter}:${type}` key and the "lessons build on the manual" rule in
   `generation/context.ts`.

## 4. Goals and non-goals

**Goals**
- Add a grade/subject by supplying a *profile* (data) plus, when the graph shape
  is new, one *adapter module* (code) — without editing core logic.
- Fail loudly: selecting a context whose graph doesn't match its adapter returns
  a clear error, never a silent empty/wrong result.
- Preserve the existing CI-maths data. The 46 tracked documents and their history
  keys (`5:manual`, …) must keep working unchanged.
- Keep storage/history/reconcile subject-agnostic (they already key off opaque
  id strings).

**Non-goals**
- No re-modelling of the bucket layout (the `<grade>/<subject>/` scoping stays).
- No attempt to make one universal graph parser. Graph shapes are diverse enough
  that a small code adapter per shape is the right unit, not a mega-config.
- Not solving generation-prompt authoring here; prompts stay per-subject files.

## 5. Proposed architecture

Two layers plug in per subject: a **curriculum adapter** (code) for axis 1, and a
**deliverable profile** (data) for axes 2–3. A **registry** binds them to a
`(grade, subject)`. The core consumes a **normalized curriculum model** and never
sees raw graph JSON again.

```
set_context(grade, subject)
        │
        ▼
   profile registry ── resolves ──▶ SubjectProfile
        │                             ├─ graph:        CurriculumAdapter   (axis 1, code)
        │                             ├─ deliverables: DeliverableSpec[]   (axes 2–3, data)
        │                             └─ capabilities: {...}               (generation feature flags)
        ▼
 CurriculumAdapter.detect(raw)  ── guard: matches? ──▶ else clear error
 CurriculumAdapter.parse(raw)   ──────────────────────▶ CurriculumModel (normalized)
        │
        ▼
 tools / generation context  ← consume the normalized model + deliverable specs only
```

### 5.1 The normalized curriculum model (the core contract)

Both adapters emit the same shape. It is a generic tree of units — general enough
for numbered chapter/lesson lists *and* for a Palier/skill-area tree. This is the
single most important interface: get it right and the rest is mechanical.

```ts
// A curriculum unit at any level. `kind` is a subject-defined role label
// ("chapter","lesson","palier","skill-area","component","task"); the core treats
// it as opaque except where a profile names a kind explicitly (e.g. the scope of
// a deliverable). Subject-specific extras ride along in `properties`.
type CurriculumUnit = {
  id: string;                       // stable id from the graph
  kind: string;                     // role at this level
  code: string | null;              // statement_code / statementCode
  title: string | null;            // short display label
  text: string | null;             // full statement text (osTexte / description)
  order: number | null;            // leconNum, or derived ordinal within siblings
  parentId: string | null;
  childIds: string[];
  buildsTowards: string[];         // unit ids (empty if the subject has no progression)
  buildsFrom: string[];
  isAssessment: boolean;           // generalizes CI maths "bilan"
  properties: Record<string, unknown>;
};

type CurriculumModel = {
  roots: string[];                 // top-level unit ids (CI maths: chapters; CE1 reading: framework/section)
  byId: Map<string, CurriculumUnit>;
  // Convenience indexes the core builds once from the tree:
  unitsOfKind(kind: string): CurriculumUnit[];
  childrenOf(id: string): CurriculumUnit[];
};
```

Notes:
- **Progression** is normalized to `buildsTowards`/`buildsFrom` id lists. CI maths
  fills them from `buildsTowards` edges; CE1 reading may leave them empty or derive
  them from `hasChild` ordering. The core doesn't care how.
- **Assessment** (`isAssessment`) replaces the CI maths-only bilan regex. Each
  adapter decides how to flag it.
- The CI maths notions `chapitreNum`/`leconNum`/`domaine`/`semaine`/`palier` become
  either first-class fields (`order`) or `properties` passthrough, so nothing is
  lost and nothing CI maths-specific leaks into the core types.

### 5.2 Curriculum adapter (axis 1, code)

One module per *graph shape*. Two subjects that happen to share a shape can share
an adapter; CI maths and CE1 reading do not, so each gets its own.

```ts
interface CurriculumAdapter {
  readonly id: string;                       // e.g. "standards-framework/graph-array-v1"
  detect(raw: unknown): boolean;             // cheap structural check — is this my schema?
  parse(raw: unknown): CurriculumModel;      // envelope + taxonomy + hierarchy → normalized tree
}
```

- `detect` is the **guard**. It answers "does this KG look like the one I know
  how to read?" — e.g. CI maths checks for a top-level `graph` array with `Chapitre`
  nodes; CE1 reading checks for `nodes`/`relationships` arrays with `hasChild` edges.
  `set_context` runs it and refuses the context with a clear message on mismatch.
- `parse` owns *all* the raw-schema knowledge that lives in
  `curriculum/knowledge-graph.ts` today. After this call, no other code touches
  raw graph JSON.

### 5.3 Deliverable spec + subject profile (axes 2–3, data)

```ts
type DeliverableSpec = {
  key: string;                       // "manual", "teacher_guide" — replaces the DocType enum
  label: string;                     // human name, e.g. "Manuel de l'élève"
  scopeKind: string;                 // which unit-kind ONE document covers ("chapter","palier","subject")
  classify: (filename: string) => boolean;  // recognize an uploaded file as this deliverable
  dependsOn: string[];               // deliverable keys that must exist first ([] = standalone)
  promptFile: string | null;         // generation prompt basename in the subject folder
  pathHint?: string;                 // optional relPath convention for uploads
};

type SubjectProfile = {
  grade: string;
  subject: string;
  graph: CurriculumAdapter;
  deliverables: DeliverableSpec[];
  capabilities: {
    exampleDomainRotation: boolean;  // CI maths storybook variety; false for CE1 reading
    characterConsistency: boolean;   // CI maths; false for CE1 reading
    // add flags as features prove subject-specific
  };
};
```

`DocType` (a closed union) is replaced by `deliverable.key` (an open string
drawn from the active profile). Tools that currently take `type: "manual" |
"lessons"` take a key validated against the active profile's deliverable list.

### 5.4 Document identity and discovery

Today: id = `${chapter}:${type}`, with `chapter` = first integer of the folder
name and `type` from `classify()`. Generalize to:

```
documentId = `${scopeValue}:${deliverableKey}`
```

where `scopeValue` identifies the scoped unit (for CI maths, the chapter number; for
CE1 reading, a Palier id or the literal subject when `scopeKind === "subject"`), and
`deliverableKey` comes from `DeliverableSpec.key`.

**Back-compat:** for CI maths, `scopeValue` = chapter number and `deliverableKey` ∈
{`manual`,`lessons`}, so ids stay exactly `5:manual` — existing history keys are
untouched. Discovery generalizes from "first int of folder + classify filename"
to a small per-profile mapping `relPath → {scopeValue, deliverableKey}`, with the
CI maths mapping reproducing today's behavior.

### 5.5 Registry and resolution

```ts
// Binds a (grade, subject) to its profile. Lookup on set_context.
const REGISTRY: Record<string, () => SubjectProfile> = {
  "ci/maths":     buildMathsProfile,
  "ce1/lecture":  buildReadingProfile,
};
```

`set_context` resolves the profile, runs `graph.detect` against the loaded KG,
and on success caches the parsed `CurriculumModel` (the existing
`onContextChange` reset already clears per-context caches).

## 6. How the two subjects map on

**CI maths** — adapter reads the `graph:[]` envelope, treats `Chapitre` nodes as
`roots` (kind `"chapter"`), `OS*` nodes as `"lesson"` children matched by
`chapitreNum`, `LearningComponent`/`Curriculum` as `"component"`/`"task"` via
`supports` edges, `buildsTowards` → progression, bilan regex → `isAssessment`.
Deliverables: `manual` (scope `chapter`) and `teacher_guide` (key kept as
`lessons` for back-compat; scope `chapter`; `dependsOn:["manual"]`). Capabilities:
both flags `true`.

**CE1 reading** — adapter reads `nodes`/`relationships`, builds the `hasChild`
tree (kinds `section`/`substage`/…/`skill-area`), attaches `LearningComponent`s
via `supports`, leaves progression empty. Deliverables: a single
`teacher_guide` (scope: TBD, see §9; `dependsOn:[]`). Capabilities: both `false`.
A student book can be added later as another `DeliverableSpec` with no core change.

## 7. Impact on the current code

| Module | Change |
|---|---|
| `curriculum/knowledge-graph.ts` | Split: raw-schema logic moves into per-subject adapters behind `CurriculumAdapter`; the file becomes the CI maths adapter (or a `curriculum/adapters/maths.ts`). |
| `types.ts` | `DocType` union → `deliverableKey: string`; add `CurriculumUnit`/`CurriculumModel`/`SubjectProfile`/`DeliverableSpec`. |
| `storage/documents.ts` | `classify()` → per-profile `relPath` mapping + deliverable `classify`. |
| `generation/context.ts` | Dependency warning reads `deliverable.dependsOn`; domain/character sections gated by `capabilities`. |
| `generation/domains.ts` | Runs only when `capabilities.exampleDomainRotation`. |
| `server.ts` | Deliverable keys validated against the active profile; tools use generic `unit`/`deliverable` vocabulary (§9.2). |
| `storage/{adapter,history}.ts`, `reconcile` | No change — already id-string agnostic. |
| `context-state.ts` | `set_context` also resolves the profile and runs the `detect` guard. |

## 8. Backward compatibility & migration

- **No data migration.** CI maths ids and bucket paths are reproduced exactly by the
  CI maths profile. The 46 tracked documents keep reconciling as tracked.
- **Guard is additive.** It only rejects graphs that would have mis-parsed
  anyway (CE1 reading currently throws inside `kgReload`; the guard turns that into a
  clear message).
- **New deliverables are additive.** Adding a CE1 reading student book later is a new
  `DeliverableSpec`; existing history is unaffected.

## 9. Open questions

1. **CE1 reading scope unit.** ANSWERED (2026-07-21): **per week** — one teaching
   guide document per week. So `scopeKind: "week"`, the scope value is a week
   number, and the document id is like `${week}:teacher_guide`. The CE1 reading KG
   carries week information ("bés / semaines" in the palier groupings); the
   CE1 reading adapter will need to surface a week ordinal per unit so discovery and
   history key on it. (CE1 wiring deferred — see phase 4.)
2. **Tool naming.** RESOLVED (2026-07-22): renamed to generic vocabulary.
   `list_chapters` → `list_units`; the `chapter` parameter → `unit` and the
   `docType`/`type` parameters → `deliverable` across `get_curriculum`,
   `get_generation_context`, `record_document_content`, `log_generation`. The
   internal history schema keeps its `chapter`/`type` field names (mapped at the
   tool boundary) so no `history.json` migration is needed. Callers of the old
   tool names/params must update.
3. **Terminology per subject.** The FR/Wolof glossary is already per-context; no
   change expected, but confirm CE1 reading ships its own `terminology.json`.
4. **Adapter granularity.** If a third subject shares CE1 reading's envelope, does it
   reuse the CE1 reading adapter or get its own? Prefer sharing by *graph shape*, not
   by subject.

## 10. Alternatives considered

- **Declarative-only profile (field-name remapping).** Rejected: the two graphs
  differ in *mechanism* (property-match vs. edge-tree) and *envelope*, not just
  names. A config expressive enough to cover both becomes a parser in JSON.
- **Full pluggable everything (each subject ships all logic).** Rejected as the
  default: most divergence is in graph parsing; deliverables and capabilities are
  well captured declaratively. Code only where code is warranted (the adapter).
- **Do nothing / keep CI maths-only.** Rejected: CE1 reading is a real, funded second
  subject; the silent-failure risk is live today.

## 11. Suggested phasing

1. **Guard only.** Add `CurriculumAdapter.detect` for CI maths + wire into
   `set_context`. Non-CI maths contexts fail clearly. Ships value immediately, no
   refactor. *(This is the "Guard + document" option; this doc is the "document".)*
2. **Extract the CI maths adapter + normalized model.** Move raw-schema logic behind
   the interface; core consumes `CurriculumModel`. Behavior-neutral for CI maths.
3. **Open the deliverable model.** Replace `DocType` with profile-driven keys +
   `DeliverableSpec`; gate generation features by `capabilities`.
4. **Add the CE1 reading adapter + profile.** *(Done, 2026-07-24.)* §9.1 resolved
   (per-week scope). Registered under **`ce1/reading`** (not `ce1/lecture`): the
   CE1 reading KG lives at `sources/ce1/reading/knowledge_graph.json`, the teacher-guide
   prompt at `PROMPT_generate_lessons.md`, `curriculum/adapters/reading.ts` parses
   the `nodes`/`relationships` + `hasChild` tree, and `profiles/reading.ts` declares
   a single standalone `teacher_guide` deliverable. History keys on the week number
   via `HistoryEntry.chapter` as planned. What the CE1 reading KG turned out to need,
   beyond the original sketch:
   - **Week ordinal** = a `Standard Grouping` node whose `description` is the week
     number (global, 1-based). Weeks 9/17/24 (integration) and 25 (evaluation) have
     no grouping and are produced with their own instructions.
   - **Duplicate weeks.** Palier-2/3 weeks appear twice — one populated grouping and
     an empty-skeleton twin; the adapter keeps the grouping with the most populated
     strands.
   - **`supports` endpoints are keyed differently** (start = component `identifier`,
     end = standard `case_identifier_uuid`), so the adapter indexes standards by
     `case_identifier_uuid` to attach learning components.
   - **Palier/genre** are derived (palier from the enclosing `substage` description
     "Palier N …"; genre mapped per palier), since the KG has no explicit field.

   Follow-ups still open: CE1 reading ships no `terminology.json` yet (`get_terminology`
   returns `[]` — loading is now tolerant of the missing file); `slice()` surfaces
   only the six week-scoped language-tool standards, not the constant Lecture / oral
   / récitation domain competencies; example-domain rotation stays off (theme
   freshness is derived from history); and evaluation-grid support is not yet added.
```
