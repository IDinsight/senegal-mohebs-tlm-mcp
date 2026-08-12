# Canonical LC — make Learning Commons the representation *at rest*

> **Status: Implemented; re-seed pending.** Landed on branch `feat/canonical-lc-migration`
> (transform `scripts/migrate-to-canonical-lc.mjs` applied to both source graphs; parser,
> adapters, coverage, recipes, explorer, and force-delete cascade threaded through). Read
> projections are **byte-identical** (both golden gates green, unchanged); `faithful-reexport`
> now emits canonical LC. Build + all tests green. **Re-seed `seed:kg-store` + deploy pending.**
> This **reverses Open Question #1**
> of [graph-native-authoring.md](graph-native-authoring.md) ("DECIDED: match the existing
> graph's convention"). The store, parser, adapters, and re-export will speak **canonical
> Learning Commons** (camelCase props, `hasPart` / `hasEducationalAlignment`, real
> `Activity` / `Course` / `Material` labels) as the internal truth — not a simplified
> serialization. Sequenced **before Scope C**, so Scope C's activities/materials are
> authored canonically from day one. Vocabulary verified against the LC
> [curriculum](https://docs.learningcommons.org/knowledge-graph/graph-reference/curriculum),
> [academic-standards](https://docs.learningcommons.org/knowledge-graph/entity-and-relationship-reference/academic-standards),
> and [learning-components](https://docs.learningcommons.org/knowledge-graph/entity-and-relationship-reference/learning-components)
> references.

## Why

Today the graph uses a *simplified serialization* — snake_case props, `hasChild` for all
containment, `supports` for all alignment, and a `Curriculum` label + `normalized_type`
indirection for content nodes. "Faithful re-export" therefore means "reproduces our
simplified form," not real LC. Moving to canonical LC makes the Firestore store an
**authoritative, re-exportable LC copy** (the standing goal), removes the mental overhead
of a translation table, and lets Scope C author `Activity`/`Material` in the real shape.

## What's already canonical (less work than it looks)

| Concern | Status |
|---|---|
| Labels `StandardsFramework`, `StandardsFrameworkItem`, `LearningComponent`, `Lesson`, `LessonGrouping` | ✅ already canonical |
| Standards hierarchy edge `hasChild` (Framework→SFI, SFI→SFI) | ✅ LC uses `hasChild` here — **keep** |
| `LearningComponent —supports→ SFI` | ✅ canonical `supports` — **keep** |
| `statement_type` / `normalized_statement_type` on SFI | ✅ real LC props (`statementType` / `normalizedStatementType`) — just camelCase |
| `buildsTowards` (maths standards progression) | ✅ canonical (LC learning-progressions) — **keep** |
| SFI CASE fields (`case_identifier_uri/uuid`, `jurisdiction`, `statementCode`, `gradeLevel`) | ✅ CASE-native — just camelCase |

## The delta to canonical

1. **Props: `snake_case → camelCase`** on every node and edge. Mechanical but pervasive
   (`academic_subject→academicSubject`, `in_language→inLanguage`, `time_required→timeRequired`,
   `group_name→groupName`, `group_level→groupLevel`, `educational_use→educationalUse`,
   `statement_code→statementCode`, `case_identifier_uuid→caseIdentifierUUID`,
   `statement_type→statementType`, `normalized_statement_type→normalizedStatementType`, …).
2. **Content containment `hasChild → hasPart`** — **only** where both ends are content
   nodes (`Course→LessonGrouping`, `LessonGrouping→Lesson`, `Lesson→Activity`,
   `Activity→Material`). Standards-side `hasChild` (Framework→SFI, SFI→SFI, SFI→LessonGrouping
   where the spine hangs the content off a standard) **stays**. So this is a *conditional*
   rename keyed on endpoint labels, not a global find/replace.
3. **Alignment `supports → hasEducationalAlignment`** where the source is a content node
   (`Lesson→SFI`: 441 reading + 112 maths; `Activity→SFI`: 104 maths). `LearningComponent→SFI`
   **stays** `supports`. So today's single `supports` edge splits by source label.
4. **Label `Curriculum → Activity` / `Course`** (and `Material` in Scope C). Drop the
   `normalized_type` content-node indirection — canonical conveys type via the **label**.
5. **Ordinals move to canonical homes.** Week number / chapter order → **`position`**
   (integer) with an optional **`ordinalName`** for display ("Semaine 3"); `LessonGrouping`
   nesting depth → **`groupLevel`**. Today reading reads the week number from a bare-number
   `description` and maths from `metadata.order` — both move to `position`.

## The one real modeling decision: where non-canonical extras live

Some data we depend on has **no canonical LC field**:

- **Parse driver** — `metadata.role` (week/chapter/expectation). *Resolved by the delta:*
  canonical conveys kind via the **label**, so the parser becomes label-driven and `role`
  is dropped. (Subject meaning — "this LessonGrouping is a *week* vs a *chapter*" — is an
  adapter projection on the label, which is already how it works.)
- **Curriculum-planning attributes** — reading's per-week `palier` and `genre`; the maths
  bilan flag already has a canonical home (`educationalUse: Assessment`).
- **Extraction provenance** — `bbox`, `page_indices`, `source_decision_ids`,
  `canonical_node_id`, `progression_context`, `source_kg`.

**Proposed:** keep a single **namespaced extension object** (retain a `metadata` — or
`x-idi` — key) for provenance + curriculum-planning extras. The canonical core is pure LC;
the sidecar is an explicit extension a *strict* canonical export can drop, while our own
re-export stays lossless. This keeps "canonical at rest" honest (every first-class field is
canonical LC) without discarding traceability or the palier/genre reads. **Confirm:** keep a
namespaced sidecar (recommended) vs. drop non-canonical data entirely vs. model palier/genre
structurally (e.g. palier as a parent grouping level).

## Architecture changes

- **Parser (`curriculum/parse-graph.ts`)** — the deepest change:
  - **Kind from label**, not `metadata.role` / `normalized_statement_type` (`roleToKind`
    retires; `labelToKind` becomes the driver).
  - **Two containment edges**: treat both `hasChild` (standards) *and* `hasPart` (content)
    as parent→child. (Today `containerEdge` is a single string → make it a set.)
  - **Two attachment edges**: `supports` (component→SFI) *and* `hasEducationalAlignment`
    (content→SFI) both fold as attachment. (Today `supportEdge` is single → set.)
  - **Order from `position`** (`numberFrom` retires in favour of a canonical `position`).
  - Grouping-vs-leaf (today `normalized_statement_type === "Standard Grouping"`) derived
    from label / having children rather than the prop.
- **Adapters** — descriptors updated to the above; `wordingAliases` point at canonical
  fields (`raw.description` stays the source mirror); `lcNodeTemplate` stamps canonical
  labels + camelCase; `recipeProfile` unchanged in shape.
- **store-bridge (`toRawEnvelope` / `serializeModel`)** — round-trips the canonical
  envelope; **faithful-reexport now emits canonical LC** (its whole contract flips — this
  is the headline acceptance change).
- **Explorer (`kg-export.ts`)** — the `supports`-fold already reverses to a display
  `hasChild`; add the same fold for `hasEducationalAlignment`, and read `hasPart` as
  containment. Labels drive colour/taxonomy already, so the by-label view is unaffected.
- **Migrations** — the Scope A/B scripts (and any maths ones) are re-pointed to emit
  canonical, OR a single new `scripts/migrate-to-canonical-lc.mjs` transforms the current
  source graphs in place (deterministic, re-runnable, `--dry`).

## Migration method + staging

Deterministic, per-subject, reviewable in stages:

1. **Transform script** — rewrite each `sources/<g>/<s>/knowledge_graph.json` to canonical:
   camelCase all props; conditional `hasChild→hasPart`; split `supports→hasEducationalAlignment`
   by source label; relabel `Curriculum→Course/Activity`; move ordinals to `position`; park
   extras under the namespaced sidecar. Re-runnable; bails if already canonical.
2. **Parser + adapters** — the set-valued edges + label-driven kinds + `position` order.
3. **Bridge + explorer + tests** — regenerate goldens; flip faithful-reexport to canonical.
4. **Re-seed** (`seed:kg-store`) + `parity:kg-store --live`; deploy the matching server.

## Acceptance / safety net

**The read projections must stay byte-identical.** Canonical-at-rest is an internal
*re-serialization of the same data* — `listUnits` / `slice` / `progression` /
`requiredCoverage` / `scopeValues` should not move, so **both golden gates
(`ci-maths.golden.test.ts`, `ce1-reading.golden.test.ts`) stay green unchanged** — the
strongest proof the conversion is lossless (same discipline as Scope A). The *only* fixtures
that change are `faithful-reexport` (now asserts canonical labels/edges/camelCase) and the
`kg-export` counts if any. `parity:kg-store` stays green.

## Open decisions to confirm before coding

1. **Non-canonical extras** — namespaced sidecar (recommended) vs. drop vs. model palier/genre
   structurally. (The one genuine modeling call.)
2. **Ordinal** — `position` as the ordinal source (recommended), with `ordinalName` for display.
3. **Transform mechanism** — one new `migrate-to-canonical-lc.mjs` over the current sources
   (recommended, single reviewable diff) vs. re-pointing the existing Scope A/B/maths scripts.
4. **Strict export** — does a *strict* canonical export (sidecar stripped) need to exist now,
   or is the lossless internal-canonical form enough for this initiative?

## Post-canonical cleanups (merged)

Two follow-on fixes surfaced while reviewing the canonicalized maths graph:

1. **RECE is a "Composants dérivés" frame** (PR #37). RECE wrapped its illustrative
   activities in a content `Course → task-groupings → activities`; the other derived
   frames (Rwanda P1, Kenya KICD, …) hang activities directly off their SFI. RECE was
   normalized to match: the `Course`, the 6 task-groupings, and the empty
   "Tâches illustratives (RECE)" wrapper SFI were removed, and the 49 activities
   re-homed onto RECE's six leaf sub-SFIs (`scripts/migrate-rece-derived-components.mjs`;
   ci/maths → 501 nodes / 877 edges).
2. **Illustrative activities align to a standard** (PR #39). The canonical transform had
   blindly turned `Activity --supports--> LearningComponent` into
   `hasEducationalAlignment → LearningComponent`, but that edge is doubly wrong:
   `hasEducationalAlignment` targets a `StandardsFrameworkItem` only, and LC defines no
   Activity↔LearningComponent edge at all. Fixed: each illustrative `Activity`
   `hasEducationalAlignment`s the **standard** (its component's single, unambiguous
   parent SFI), and the specific component it exemplifies rides in
   `metadata.illustratesComponent = {id, name, order}`
   (`scripts/migrate-activity-alignment-canonical.mjs`). `buildSlice` groups a lesson's
   illustrative tasks by that property (ordered) instead of the old edge → byte-identical
   reads, golden green. After: `hasEducationalAlignment` is 216 edges, **all → SFI**;
   zero Activity↔LearningComponent edges. See *Decision 5* in
   [graph-native-authoring.md](graph-native-authoring.md).

## Then: Scope C, authored canonically

With canonical at rest, Scope C (activities & materials inside a lesson —
[graph-native-authoring.md](graph-native-authoring.md#scope-c)) creates real `Activity` /
`Material` nodes with `hasPart` / `hasEducationalAlignment` from the start — no second
migration.
