# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A remote **MCP server** ("Senegal Maths — TLM") that helps experts author teaching materials (pupil manuals + lesson sheets) from a curriculum knowledge graph. It exposes MCP tools, not a UI. The graph lives in Firestore in the raw *Learning Commons* (LC) ontology; generated `.docx` files + their history live in Firebase Storage; auth is Supabase JWT. Work is always scoped to an active `(grade, subject)` via `set_context`. Actual document generation is LLM-driven — the server provides curriculum context, prompts, signed upload URLs, and history; it never renders a `.docx` itself.

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

Tests use `vitest`. They never touch real Firebase/Firestore: a **memory KG store** (`createMemoryKgStore` + `__setKgStoreForTest`) and a **fake StorageAdapter** (`__setStorageForTest`) are injected, and `process.env.KG_SOURCE = "firestore"` exercises the lifecycle-aware path. Follow the setup in `src/kg-store/lifecycle.test.ts` / `src/server/preview.test.ts` for new suites.

## Module layering (enforced)

`npm run check:cycles` (run automatically by `build`) fails on any import cycle **and** on any import that points "up" a layer. Imports only ever point **down**:

```
app       server/* · index.ts · http.ts · activate.ts
adapters  adapters/*                          — one behavior module per subject
services  storage/* · curriculum/* · generation/* · kg-store/*   — never import adapters
core      config.ts · types.ts · context/{state,shared} · utils/*   — leaves
```

Consequences that constrain where code goes: `kg-store/` is **subject-agnostic** (it knows nodes/edges, never "chapter"/"bilan"); anything subject-specific is injected from the app layer (e.g. the `coverage` hook, `wordingAliases`). `curriculum/store-bridge.ts` owns the `CurriculumModel ⇄ nodes/edges` round-trip so neither `kg-store` nor `adapters` depend on each other. `context/state.ts` is a dependency-light leaf — the adapter resolution + schema guard that need `storage`/`adapters` live in the root `activate.ts` instead, to avoid a cycle. `check-cycles.mjs` has a `LAYERS` map; a new top-level module must be added there.

## Subject-adapter architecture

Both subjects now share the **converged `{ nodes, relationships }` envelope** with the LC metadata scheme (`normalized_statement_type` = container vs leaf; `metadata.role` = fine role — week/subtopic/strand/expectation; `statement_type` = category on leaves; `description` = text/title; number in `metadata.order` for maths, in the bare-number `description` for reading). The subjects still differ in their READ projections (CI maths → chapter/lesson with `chapitreNum`/`leconNum`/`domaine` + a two-axis week/content structure; CE1 reading → week/strand). So the shared *parse* is one generic traversal (`curriculum/parse-graph.ts::parseGraph`, driven by a per-subject descriptor), while all subject-specific behavior lives in **one adapter module per subject** (`src/adapters/ci-maths.ts`, `ce1-reading.ts`), bound to a `(grade, subject)` key in `src/adapters/index.ts`.

- Adapters are **behavior only** — `detect`/`parse` (a thin `GraphParseDescriptor` handed to the shared `parseGraph`), the LC→friendly projection (`listUnits`/`slice`/`progression`/`requiredCoverage`/`scopeValues`), `buildGenerationContext`, plus `deliverables`, `capabilities`, and the edit-surface declarations (`wordingAliases`, `structuralAliases`, `recipeProfile`, `coverageWarnings`). There is **no** schema/integrity declaration on the adapter — write-safety lives in the write tools.
- Raw LC fields survive under `properties.raw` on each stored node; normalized fields (`title`/`text`/`order`/`isAssessment`) sit alongside. `id` is the LC UUID verbatim. Editing wording via `upsert_property` updates *both* the normalized field and its `raw.*` mirror atomically (that's what `wordingAliases` maps).
- `KG_SOURCE` (env, resolved lazily via `config.ts::kgSource()`): `bundle` reads `sources/.../knowledge_graph.json` from disk (legacy/dev); `firestore` reads the seeded node/edge store. In firestore mode, `activateContext` hydrates the parsed `CurriculumModel` from the **published slot** once and pins it in the session bag under `PRELOADED_MODEL_KEY`; the adapter's sync read methods (`ensure()`) read from there.

## Draft/published + the curator loop

The KG store is **double-buffered**: two slots (`a`/`b`) behind a pointer `{ publishedSlot, draftSlot }`. Reads and generation resolve to **published**; edits stage onto the **draft**; `publish_draft` is an **atomic pointer flip**. `createDraft` snapshots published byte-for-byte (ids preserved).

Every graph mutation is **two-phase** (`kg-store/mutations.ts::runGraphMutation`): a dry-run returns a per-mutation diff + warnings + an opaque `confirmationToken` (no state change); the confirm re-checks the token (base version still current, nonce unused, mutation+args match) then applies to the draft only. Roles (`authz.ts`): `curator` may apply/discard, `approver` also publishes; unknown/no-role can still read+generate. Every mutation and denial is recorded in an **append-only audit** (`AuditRecord`), committed in the same transaction as the state write. `get_capabilities` is a read-only *mirror* — every field is sourced from the module that actually enforces it (never a second copy), and `capabilities.test.ts` asserts that mirror property.

Curriculum edits are exposed as **composite recipes** (`add_lesson`/`add_chapter`/`move_lesson`/`split_chapter`/`renumber`) over the raw structural verbs — available only where the adapter declares a `recipeProfile`. Chapter↔lesson membership is the `hasChild` **edge** (the old denormalized `chapitreNum` join is gone), so move/split rewire the edge and renumber changes only the chapter's own number — no cross-lesson number cascade. CI maths lessons carry a second axis: a `week → OS` schedule edge alongside the `chapter → OS` content edge, so a lesson legitimately has two parents (the multi-parent coverage rule is scoped to *chapter* parents).

## Preview generation (isolated from published)

`preview_generation(unit, deliverable)` closes the editing loop: the dry-run/`diff_draft` show the graph **diff**; preview shows the resulting **material**. It resolves the curriculum from the **draft slot** (same slot `diff_draft` reads) and runs the *same* `buildGenerationContext` on it — that method takes an optional pre-resolved `model` so the published path stays byte-identical. Isolation is the invariant: preview output goes through `create_preview_upload_url` to a **segregated `previews/` prefix** (sibling of `documents/`, invisible to `reconcile`/`list_documents`) with short-lived, labelled URLs — never the canonical bucket, `log_generation`, or history. Role-gated like `diff_draft` (curator+approver); audited as a distinct `preview` event; scoped to one unit+deliverable. See `docs/preview-generation-findings.md`.

## Conventions & gotchas

- **Session model**: per-session in HTTP mode, process-wide in stdio. Context-derived caches (active adapter, preloaded model, history cache) live in the session **bag** and are cleared wholesale on `set_context`. Don't hold subject state across a context switch.
- **New subject read state is threaded, not shared**: adapter projections take the `CurriculumModel` as an argument (see CI maths/CE1 reading `buildGenerationContext(…, model?)`) so a draft-resolved read can't collide with a concurrent published read — do not reintroduce a mutable per-adapter "current model" override.
- **Confirmation gates differ by lifecycle**: document tools (`create_upload_url`, `log_generation`, `record_document_content`) write **live** (`action` says "no draft, no undo"); graph mutations **stage a draft** (`action` says "nothing reaches generation until you publish"). Same envelope shape, deliberately different stakes.
- **`docs/*.md`** are tracked design notes (architecture, KG explorer, mutations framework, preview findings) — read them for deep dives. `.claude/settings.local.json` stays git-ignored via the `*.json` rule.
- **Git**: `main` is the default; land changes via a branch + PR (see recent history). Commit only when asked.
