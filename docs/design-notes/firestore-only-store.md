# Firestore is the only KG store

> **Status: Phase A built (in-repo); Phases B–E planned.** This note records the
> decision to make Firestore the **single** knowledge-graph store and retire the
> `bundle` (on-disk `sources/`) read path, the seed/parity treadmill, and the
> `KG_SOURCE` toggle. The graph is exported on demand (a backup / interchange
> artifact) and a new graph is imported on demand; nothing is kept in lockstep
> with the store anymore.

## Why

Two "stores" exist today: the on-disk `sources/**/knowledge_graph.json` bundle and
the Firestore store. They are kept in sync by a treadmill — `seed:kg-store`
(sources → Firestore), `export:kg-store` (Firestore → sources), and
`parity:kg-store` / the parity + faithful-re-export tests (assert the two agree).
That constant syncing is the cost this change removes: **Firestore becomes the
sole source of truth**, `sources/` stops being a source of truth at all, and the
only interchange is an explicit export (backup) and import (bootstrap / new graph).

## Decisions

| # | Decision | Choice |
|---|---|---|
| F1 | `sources/` as a source of truth | **Removed.** The KG lives only in Firestore. The graph JSONs leave the repo; the realistic graphs tests need are relocated to `test/fixtures/**` as plain committed test data (not synced, no parity). |
| F2 | Per-subject on-disk assets (`terminology.json`) | **Kept on disk** as static subject assets under `assets/<ws>/<grade>/<subject>/` — a rarely-changing glossary fallback, not curriculum a curator edits through the loop. `example_domains`' default pool moves into config. |
| F3 | Import / export surface | **Operator scripts.** Repurpose `seed-kg-store.mjs` → `import-kg.mjs` (a provided LC-graph JSON + optional profile/guide → a namespace's published slot); keep the export script as the backup. No new runtime tool surface. |
| F4 | Context discovery | **From the store.** `listAvailableContexts()` enumerates the store's namespaces (via `listNamespaces()`), not an on-disk `sources/` scan. |

## Plan (phases)

- **A — store-backed context discovery** *(built)*. Adds `listNamespaces()` to the
  store (interface + Firestore + memory), a `parseNamespace()` inverse of
  `kgNamespace()` (filtering the `_catalog` partitions), a settable snapshot in
  the `context/state.ts` leaf (`setAvailableContexts`), and an app-layer
  `refreshAvailableContexts()` that reads the store and installs the parsed
  contexts. Wired at startup in firestore mode (best-effort: on a store error it
  falls back to the disk scan). **Non-breaking** — bundle mode and every existing
  test still see the disk scan (the snapshot is only set by the startup refresh,
  which tests don't run). This de-risks the hardest mechanic against the real
  store before anything is removed.
- **B — delete the bundle path + `KG_SOURCE`**. Drop `activate.ts`'s disk branch +
  `detect()` guard, `engine.ts`'s disk fallback, and `kgSource()`/`KgSource`/
  `kgFile`. Remove the mode branches in `graph.ts`, `preview.ts`, `profile.ts`
  (profile always from the store cell; `edit_profile` always available),
  `capabilities.ts`, `health.ts`, `http.ts`, `index.ts`. The in-repo profile
  literals survive as the import default + validation + test fixtures.
- **C — import / export scripts** (F3); delete `seed-kg-store.mjs` +
  `parity-check.mjs`; repoint `seed-catalog.mjs`'s input; update `package.json`.
- **D — tests**. Relocate fixtures to `test/fixtures/`; a shared
  `loadFixture` / `seedMemoryStoreFromFixture` helper; rewrite the ~30 tests'
  loading path and drop their `KG_SOURCE` setup. Delete `parity.test.ts` and
  `faithful-reexport.test.ts` (or repurpose the latter as an export→import
  round-trip guard).
- **E — docs**. CLAUDE.md, the store/architecture technical-reference; strip
  seed/parity/bundle references.

## Rollout

The deployed server already runs `KG_SOURCE=firestore`, so there is **no data
migration** — removing the toggle matches live, and the Docker image simply stops
shipping `sources/`. Phase A is safe to deploy on its own: store-backed discovery
takes over when the startup snapshot loads, with the disk scan as a fallback if
the store read fails.

## Related

- [`../technical-reference/store.md`](../technical-reference/store.md) — the store,
  slots, pointer, and the seed/parity machinery being retired.
- [`../technical-reference/architecture-and-extending.md`](../technical-reference/architecture-and-extending.md)
  — the `KG_SOURCE` modes and the add-a-subject flow this reshapes.
