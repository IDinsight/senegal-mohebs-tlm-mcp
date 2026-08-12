# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A remote **MCP server** ("Senegal Maths — TLM") that helps experts author teaching materials (pupil manuals + lesson sheets) from a curriculum knowledge graph. It exposes MCP tools, not a UI. The graph lives in Firestore as the raw *Learning Commons* (LC) ontology; generated `.docx` files + their history live in Firebase Storage; auth is Supabase JWT. Work is always scoped to an active `(grade, subject)` via `set_context`. Document generation is LLM-driven — the server provides curriculum context, prompts, signed upload URLs, and history; it never renders a `.docx` itself.

## Communicating with the user

Explain in **plain language** — avoid jargon, and define any technical term you must use. When explaining a concept or weighing a tradeoff, ground it in a **concrete example**: a small worked case, real numbers, or an analogy. Abstract prose on its own is hard to follow. Lead with the plain answer, then show it. This applies to every explanation, not only when asked.

## Commands

```bash
npm run build          # check-cycles + tsc → dist/  (Docker build runs this)
npm test               # vitest run (all suites)
npx vitest run src/server/preview.test.ts        # a single test file
npx vitest run -t "reflects a staged edit"       # tests matching a name
npm run typecheck      # tsc --noEmit
npm run check:cycles   # layering + import-cycle check (also part of build)
npm run start          # stdio MCP server (dist/index.js)
npm run start:http     # HTTP MCP server (dist/http.js) — remote/Cloud Run mode
npm run seed:kg-store  # seed Firestore from sources/ (needs KG_SOURCE=firestore + creds)
npm run parity:kg-store  # assert firestore reads == bundle reads, per context
```

Tests use `vitest` and never touch real Firebase/Firestore: a **memory KG store** (`createMemoryKgStore` + `__setKgStoreForTest`) and a **fake StorageAdapter** (`__setStorageForTest`) are injected, and `KG_SOURCE="firestore"` exercises the lifecycle path. Follow `src/kg-store/lifecycle.test.ts` / `src/server/preview.test.ts` for new suites.

## Module layering (enforced)

`npm run check:cycles` (run automatically by `build`) fails on any import cycle **and** on any import that points "up" a layer. Imports only ever point **down**:

```
app       server/* · index.ts · http.ts · activate.ts
adapters  adapters/*                          — one behavior module per subject
services  storage/* · curriculum/* · generation/* · kg-store/*   — never import adapters
core      config.ts · types.ts · context/{state,shared} · utils/*   — leaves
```

Consequences: `kg-store/` is **subject-agnostic** (it knows nodes/edges, never "chapter"/"bilan") — anything subject-specific is injected from the app layer (e.g. `coverage`, `wordingAliases`, `lcNodeTemplate`). `curriculum/store-bridge.ts` owns the `CurriculumModel ⇄ nodes/edges` round-trip so `kg-store` and `adapters` never depend on each other. `context/state.ts` is a dependency-light leaf; the adapter resolution + schema guard that need `storage`/`adapters` live in root `activate.ts` to avoid a cycle. A new top-level module must be added to the `LAYERS` map in `check-cycles.mjs`.

## Subject-adapter architecture

Both subjects share the converged `{ nodes, relationships }` envelope in **canonical Learning Commons** (see `docs/design-notes/canonical-lc-migration.md`): real LC labels (`Lesson`/`LessonGrouping`/`Activity`/`Course`/`Material`/`StandardsFrameworkItem`/`LearningComponent`), **camelCase** props (`normalizedStatementType` = container vs leaf; `statementType` = category on leaves; `description` = text/title; ordinal in `position`), containment split across `hasPart` (content) + `hasChild` (standards hierarchy), and alignment across `hasEducationalAlignment` (content→SFI) + `supports` (component→SFI). Our non-canonical extras (extraction provenance, reading's palier/genre, `metadata.role`) live verbatim in a `metadata` **extension sidecar**. The shared *parse* is one generic traversal (`curriculum/parse-graph.ts::parseGraph`, driven by a per-subject `GraphParseDescriptor` — a node's `metadata.role` **and** its top-level LC `label` both map to a kind; containment/attachment are each a *set* of edge types); all subject-specific behavior lives in **one adapter per subject** (`src/adapters/ci-maths.ts`, `ce1-reading.ts`), keyed by `(grade, subject)` in `src/adapters/index.ts`. Read projections differ (CI maths → chapter/lesson; CE1 reading → week/strand).

**CI maths is graph-native** — authored teaching content lives in the LC **content layer**, distinct from the standards **spine** (see `docs/design-notes/graph-native-authoring.md`, live). A *chapter* is a content `LessonGrouping` (label-keyed; its type is `groupName` — Chapitre/Unité/Module); a *lesson* is a content `Lesson` node that `hasEducationalAlignment` to its spine `expectation` (the objectif spécifique — an own kind that keeps the OS text + components/tasks). A lesson has two containment parents: its grouping via `hasPart` (content axis) and its week via `hasChild` (schedule axis). The **bilan** is explicit data (`educationalUse: "Assessment"` on the Lesson), not a parse-time heuristic. **CE1 reading has the same content layer**: each week is a `LessonGrouping` (kind `week`) holding **`Jour 1–5` day `LessonGrouping`s** (kind `day`, `groupName "Jour"`), each holding that day's session `Lesson`s (Scope B: 22 sessions/week across the 5 days), which `hasEducationalAlignment` the spine standard they teach. So both subjects share the LC content-layer labels + alignment structure — the grouping's read-*kind* (chapter vs week) is the remaining subject-specific projection. (Maths also carries **RECE + six other "Composants dérivés" frames**: each is a `StandardsFrameworkItem` holding derived `LearningComponent`s and illustrative `Activity`s directly via `hasChild`. Each illustrative Activity `hasEducationalAlignment`s a **standard** (its component's parent SFI) and carries the specific component it exemplifies in `metadata.illustratesComponent = {id, name, order}` — canonical LC has no Activity↔LearningComponent edge. `buildSlice` surfaces these as a lesson's per-component illustrative tasks.)

- Adapters are **behavior only**: `detect`/`parse`, the LC→friendly projection (`listUnits`/`slice`/`progression`/`requiredCoverage`/`scopeValues`), `buildGenerationContext`, plus `deliverables`, `capabilities`, and the edit-surface declarations (`wordingAliases`, `structuralAliases`, `recipeProfile`, `lcNodeTemplate`, `coverageWarnings`). No schema/integrity lives on the adapter — write-safety is in the write tools.
- Each stored node keeps its raw LC fields under `properties.raw`, its top-level LC `labels`, and (spine nodes) normalized fields (`title`/`text`/`order`/`isAssessment`) alongside. `id` is the LC UUID verbatim. `upsert_property` edits the normalized field and its `raw.*` mirror atomically (`wordingAliases`). Recipe-created nodes stamp their LC identity (`metadata.role`/`normalizedStatementType`/`statementType`/`normalizedType`/`labels`) from the adapter's `lcNodeTemplate`, so they round-trip through the parser.
- `KG_SOURCE` (env, via `config.ts::kgSource()`): `bundle` reads `sources/.../knowledge_graph.json` from disk (dev); `firestore` reads the seeded store. In firestore mode `activateContext` hydrates the `CurriculumModel` once from the **published slot** and pins it in the session bag under `PRELOADED_MODEL_KEY`; adapter sync reads (`ensure()`) read from there.

## Full-graph store + faithful re-export

The Firestore store holds the **complete raw LC graph**, not just the curriculum spine: every raw node (spine nodes tagged `spine:true` + normalized fields; framework/derived nodes `spine:false` + `raw` only) and every raw edge with its real type — `hasChild`/`hasPart`/`supports`/`hasEducationalAlignment`/`relatesTo`/`buildsTowards`. Reads are unchanged: hydration rebuilds the raw envelope (`store-bridge.ts::toRawEnvelope`) and re-runs `adapter.parse`, so the read model is byte-identical to a bundle read — guarded by `parity:kg-store`. Because the store *is* the raw graph, `toRawEnvelope` also reproduces the source JSON (so the store can replace the bundle; guard: `curriculum/faithful-reexport.test.ts`). Changing what's stored needs a re-seed (`seed:kg-store`). The KG explorer (`src/kg-export.ts`) follows the **LC ontology only**: every node is categorized/coloured by its LC **label** (`StandardsFramework`/`StandardsFrameworkItem`/`Course`/`LessonGrouping`/`Lesson`/`Activity`/`Material`/`LearningComponent`), and it offers two generic views — a **containment hierarchy** (walk `hasChild`+`hasPart` from the framework root) and **by-label** — with no subject vocabulary (no domaine/chapitre/semaine/strand/palier). The detail panel renders the node's raw LC properties generically. `supports` and `hasEducationalAlignment` fold (reversed) into the display containment tree so components/lessons stay reachable (display-only; the store keeps the real edges).

## Draft/published + the curator loop

The KG store is **double-buffered**: two slots (`a`/`b`) behind a pointer `{ publishedSlot, draftSlot }`. Reads and generation resolve to **published**; edits stage onto the **draft**; `publish_draft` is an **atomic pointer flip**. `createDraft` snapshots published byte-for-byte (ids preserved).

Every graph mutation is **two-phase** (`kg-store/mutations.ts::runGraphMutation`): a dry-run returns a diff + warnings + an opaque `confirmationToken` (no state change); the confirm re-checks the token (base version current, nonce unused, mutation+args match) then applies to the draft only. Roles (`authz.ts`): `curator` may apply/discard, `approver` also publishes; unknown/no-role can still read+generate. Every mutation and denial is recorded in an **append-only audit** (`AuditRecord`), committed in the same transaction as the state write. `get_capabilities` is a read-only *mirror* — every field is sourced from the module that enforces it (never a copy), asserted by `capabilities.test.ts`.

Curriculum edits are exposed as **composite recipes** (`add_lesson`/`add_lesson_grouping`/`move_lesson`/`split_lesson_grouping`/`renumber`) over the raw structural verbs — available only where the adapter declares a `recipeProfile`. `add_lesson` creates a content lesson under a grouping **and aligns it (`supports`) to an existing `expectation`** (a lesson can't invent a standard); `add_lesson_grouping` creates an empty grouping with a `groupName` type. Grouping↔lesson membership is the `hasChild` **edge**, so move/split rewire the edge and renumber changes only the grouping's own number — no cross-lesson cascade. CI maths lessons carry a second axis: a `week → lesson` schedule edge alongside the `LessonGrouping → lesson` content edge, so a lesson legitimately has **two parents** (the multi-parent coverage rule is scoped to *grouping* parents; and force-deleting a grouping does not orphan its week-shared lessons).

## Preview generation (isolated from published)

`preview_generation(unit, deliverable)` closes the editing loop: `diff_draft` shows the graph **diff**; preview shows the resulting **material**. It resolves the curriculum from the **draft slot** and runs the *same* `buildGenerationContext` (which takes an optional pre-resolved `model`, keeping the published path byte-identical). Isolation is the invariant: output goes through `create_preview_upload_url` to a **segregated `previews/` prefix** (invisible to `reconcile`/`list_documents`) with short-lived, labelled URLs — never the canonical bucket, `log_generation`, or history. Role-gated like `diff_draft` (curator+approver); audited as a distinct `preview` event. See `docs/design-notes/preview-generation-findings.md`.

## Conventions & gotchas

- **Session model**: per-session in HTTP mode, process-wide in stdio. Context-derived caches (active adapter, preloaded model, history cache) live in the session **bag** and are cleared wholesale on `set_context`. Don't hold subject state across a context switch.
- **Read state is threaded, not shared**: adapter projections take the `CurriculumModel` as an argument (`buildGenerationContext(…, model?)`) so a draft-resolved read can't collide with a concurrent published read. Don't reintroduce a mutable per-adapter "current model".
- **Confirmation gates differ by lifecycle**: document tools (`create_upload_url`, `log_generation`, `record_document_content`) write **live** ("no draft, no undo"); graph mutations **stage a draft** ("nothing reaches generation until you publish"). Same envelope, deliberately different stakes.
- **Docs**: `docs/technical-reference.md` is the operational manual (config, add-a-subject, runbook); `docs/design-notes/*.md` hold the per-subsystem design rationale (architecture, mutations, explorer, preview, audit, **graph-native authoring** — the lesson↔expectation split). Each design note carries a **Status** line — heed "Historical / superseded" ones.
- **Git**: `main` is the default; land changes via a branch + PR. Commit only when asked.
</content>
