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

Both subjects share the converged `{ nodes, relationships }` envelope with the LC metadata scheme (`normalized_statement_type` = container vs leaf; `metadata.role` = fine role, week/subtopic/strand/expectation; `statement_type` = category on leaves; `description` = text/title; number in `metadata.order` for maths, bare-number `description` for reading). The shared *parse* is one generic traversal (`curriculum/parse-graph.ts::parseGraph`, driven by a per-subject `GraphParseDescriptor`); all subject-specific behavior lives in **one adapter per subject** (`src/adapters/ci-maths.ts`, `ce1-reading.ts`), keyed by `(grade, subject)` in `src/adapters/index.ts`. Read projections differ (CI maths → chapter/lesson with a two-axis week/content structure; CE1 reading → week/strand).

- Adapters are **behavior only**: `detect`/`parse`, the LC→friendly projection (`listUnits`/`slice`/`progression`/`requiredCoverage`/`scopeValues`), `buildGenerationContext`, plus `deliverables`, `capabilities`, and the edit-surface declarations (`wordingAliases`, `structuralAliases`, `recipeProfile`, `lcNodeTemplate`, `coverageWarnings`). No schema/integrity lives on the adapter — write-safety is in the write tools.
- Each stored node keeps its raw LC fields under `properties.raw`, its top-level LC `labels`, and (spine nodes) normalized fields (`title`/`text`/`order`/`isAssessment`) alongside. `id` is the LC UUID verbatim. `upsert_property` edits the normalized field and its `raw.*` mirror atomically (`wordingAliases`). Recipe-created nodes stamp their LC identity (`role`/`normalized_statement_type`/`statement_type`/`labels`) from the adapter's `lcNodeTemplate`, so they round-trip through the parser.
- `KG_SOURCE` (env, via `config.ts::kgSource()`): `bundle` reads `sources/.../knowledge_graph.json` from disk (dev); `firestore` reads the seeded store. In firestore mode `activateContext` hydrates the `CurriculumModel` once from the **published slot** and pins it in the session bag under `PRELOADED_MODEL_KEY`; adapter sync reads (`ensure()`) read from there.

## Full-graph store + faithful re-export

The Firestore store holds the **complete raw LC graph**, not just the curriculum spine: every raw node (spine nodes tagged `spine:true` + normalized fields; framework/derived nodes `spine:false` + `raw` only) and every raw edge with its real type — `hasChild`/`supports`/`relatesTo`/`buildsTowards` (`supports` is no longer folded into `hasChild`). Reads are unchanged: hydration rebuilds the raw envelope (`store-bridge.ts::toRawEnvelope`) and re-runs `adapter.parse`, so the read model is byte-identical to a bundle read — guarded by `parity:kg-store`. Because the store *is* the raw graph, `toRawEnvelope` also reproduces the source JSON (so the store can replace the bundle; guard: `curriculum/faithful-reexport.test.ts`). Changing what's stored needs a re-seed (`seed:kg-store`). The KG explorer (`src/kg-export.ts`) surfaces the whole graph — non-spine nodes get a neutral `framework` legend bucket, and `supports` is folded into the display `hasChild` tree so components/tasks stay reachable (display-only; the store keeps the real edges).

## Draft/published + the curator loop

The KG store is **double-buffered**: two slots (`a`/`b`) behind a pointer `{ publishedSlot, draftSlot }`. Reads and generation resolve to **published**; edits stage onto the **draft**; `publish_draft` is an **atomic pointer flip**. `createDraft` snapshots published byte-for-byte (ids preserved).

Every graph mutation is **two-phase** (`kg-store/mutations.ts::runGraphMutation`): a dry-run returns a diff + warnings + an opaque `confirmationToken` (no state change); the confirm re-checks the token (base version current, nonce unused, mutation+args match) then applies to the draft only. Roles (`authz.ts`): `curator` may apply/discard, `approver` also publishes; unknown/no-role can still read+generate. Every mutation and denial is recorded in an **append-only audit** (`AuditRecord`), committed in the same transaction as the state write. `get_capabilities` is a read-only *mirror* — every field is sourced from the module that enforces it (never a copy), asserted by `capabilities.test.ts`.

Curriculum edits are exposed as **composite recipes** (`add_lesson`/`add_chapter`/`move_lesson`/`split_chapter`/`renumber`) over the raw structural verbs — available only where the adapter declares a `recipeProfile`. Chapter↔lesson membership is the `hasChild` **edge**, so move/split rewire the edge and renumber changes only the chapter's own number — no cross-lesson cascade. CI maths lessons carry a second axis: a `week → OS` schedule edge alongside the `chapter → OS` content edge, so a lesson legitimately has **two parents** (the multi-parent coverage rule is scoped to *chapter* parents; and force-deleting a chapter does not orphan its week-shared lessons).

## Preview generation (isolated from published)

`preview_generation(unit, deliverable)` closes the editing loop: `diff_draft` shows the graph **diff**; preview shows the resulting **material**. It resolves the curriculum from the **draft slot** and runs the *same* `buildGenerationContext` (which takes an optional pre-resolved `model`, keeping the published path byte-identical). Isolation is the invariant: output goes through `create_preview_upload_url` to a **segregated `previews/` prefix** (invisible to `reconcile`/`list_documents`) with short-lived, labelled URLs — never the canonical bucket, `log_generation`, or history. Role-gated like `diff_draft` (curator+approver); audited as a distinct `preview` event. See `docs/design-notes/preview-generation-findings.md`.

## Conventions & gotchas

- **Session model**: per-session in HTTP mode, process-wide in stdio. Context-derived caches (active adapter, preloaded model, history cache) live in the session **bag** and are cleared wholesale on `set_context`. Don't hold subject state across a context switch.
- **Read state is threaded, not shared**: adapter projections take the `CurriculumModel` as an argument (`buildGenerationContext(…, model?)`) so a draft-resolved read can't collide with a concurrent published read. Don't reintroduce a mutable per-adapter "current model".
- **Confirmation gates differ by lifecycle**: document tools (`create_upload_url`, `log_generation`, `record_document_content`) write **live** ("no draft, no undo"); graph mutations **stage a draft** ("nothing reaches generation until you publish"). Same envelope, deliberately different stakes.
- **Docs**: `docs/technical-reference.md` is the operational manual (config, add-a-subject, runbook); `docs/design-notes/*.md` hold the per-subsystem design rationale (architecture, mutations, explorer, preview, audit). Each design note carries a **Status** line — heed "Historical / superseded" ones.
- **Git**: `main` is the default; land changes via a branch + PR. Commit only when asked.
</content>
