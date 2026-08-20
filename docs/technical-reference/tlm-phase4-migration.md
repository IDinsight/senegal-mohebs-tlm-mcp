# Phase 4 runbook — TLM document-model migration + cutover

**Status:** Planned (not yet executed). Phases 1–3 have landed on `feat/tlm-model-foundation`
(the labels, explorer view, and the `walk_document` reader). Phase 4 is the **live data
migration + the final code step + deploy** that flips real documents onto the new model.
It needs Firestore credentials and a Cloud Run redeploy, so it **cannot be run from the dev
box** — this file is the runbook for whoever runs it with creds.

Design rationale: [`../design-notes/teaching-learning-materials.md`](../design-notes/teaching-learning-materials.md).
Deploy fundamentals this leans on: [`deployment.md`](deployment.md) and
[`store.md`](store.md) (export/import, slots, the two-phase framework).

---

## What Phase 4 changes, in one picture

Today a "document" and its formatting are **overloaded onto canonical curriculum nodes**:

```
BEFORE (stopgaps)
  Course "Manuel de l'élève"            ← document identity IS the Course
    └─hasPart→ Chapitre → Lesson
                            └─usesRoutine→ InstructionalRoutine (metadata.role/catalogKind = "formatter")
                                             └─hasPart→ Material   ← the formatting rules
```

Phase 4 gives the document its **own** node beside the curriculum, and moves formatting under
it — nothing is overloaded any more:

```
AFTER (this migration)
  TeachingLearningMaterial "Manuel de l'élève"   ← the document, metadata.assemblyGuide = "how to build me"
    ├─covers→ Course                              ← coarse scope (or per-section, below)
    ├─hasPart→ Formatter → FormatterSpec          ← doc-wide formatting (was a usesRoutine routine)
    └─hasPart→ DocumentSection (position N)        ← optional fine spine
                 ├─covers→ Lesson                  ← this section renders this lesson
                 └─hasPart→ Formatter → FormatterSpec   ← per-section formatting

  Course → Chapitre → Lesson                       ← curriculum, now free of usesRoutine formatters
```

`walk_document(tlmId)` already reads exactly this shape (see phase 3). Phase 4 is about
**creating** that shape from the live graph and **retiring** the old edges.

---

## Preconditions (do these first, in order)

1. **Land phases 1–3.** Merge `feat/tlm-model-foundation` to `main` (or cut the release
   branch from it). The migration script and the deployed server both depend on the phase-1
   labels + phase-3 reader existing in `dist/`.
2. **Creds + prefix.** Export the same env the server uses so the namespace lines up:
   `SERVICE_ACCOUNT_KEY_PATH` (or `SERVICE_ACCOUNT_KEY_JSON`), `FIREBASE_STORAGE_BUCKET`,
   `TLM_BUCKET_PREFIX`. Getting `TLM_BUCKET_PREFIX` wrong writes to the wrong namespace.
3. **`gcloud auth login`** if the deploy step will use your user identity (user-only step;
   see [[project_deploy_code_vs_data]] in memory — periodic re-auth is expected).
4. **Build:** `cd backend && npm run build` (the scripts import from `dist/`).
5. **Freeze writes** on the target namespace during the migration window (no curator editing
   ci/maths while the graph is being transformed) — the transform reads the published graph
   and re-imports it; a concurrent edit would be lost.

## Scope of this migration

The two live documents that exist today are both **CI/maths Courses**
(see [[project_maths_course_root]]):

| Document | Today (Course) | Gets a TLM | First `DocumentSection` spine? |
| --- | --- | --- | --- |
| Teacher's Guide | Course → weeks → lessons | yes, `covers` the Course | no — Course fallback is fine |
| Student's Book | Course → chapters → container Lesson → Activities | yes, `covers` the Course | **yes** (best candidate — its per-chapter/per-page layout is what sections model) |

CE1/reading has **no** document/formatter layer yet, so it is out of scope for Phase 4 — its
TLM is minted whenever its first document is authored, using the same tools, no migration.

---

## Step A — relabel the formatter routines → `Formatter` (+ `FormatterSpec`)

**What we're finding.** A live formatter today is an `InstructionalRoutine` whose
`metadata.catalogKind === "formatter"` **or** `metadata.role === "formatter"` (both count —
see `src/kg-recipes/catalog.ts::kindOf`). It hangs off a Lesson by a `usesRoutine` edge, and
its rules live in `Material` grandchildren (`Formatter ─hasPart→ FormatterSpec` is the new
home for those rules).

**Transform (deterministic, re-runnable):**
- For every routine node that `kindOf` classifies as a formatter:
  - swap its `labels` from `["InstructionalRoutine"]` → `["Formatter"]`;
  - drop the now-redundant `metadata.catalogKind`/`metadata.role = "formatter"` tags (the label
    now carries the kind — keep the graph canonical-clean);
  - relabel its rule-bearing `Material` children → `FormatterSpec`, keeping their `content`
    verbatim and their `hasPart` edge from the formatter.
- Leave the routine's **`usesRoutine` edge in place for now** — Step D re-homes it. (Removing
  it here would orphan the formatter before the TLM exists to hold it.)

**Guard:** bail if there are zero formatter-kind routines (already migrated / wrong
namespace), matching the house pattern in `scripts/migrate-rece-derived-components.mjs`.

## Step B — mint one `TeachingLearningMaterial` per document

For each Course in the scope table:
- create a `TeachingLearningMaterial` node (title = the document's name; `metadata.assemblyGuide`
  = the "how to build me" prose, sourced from the retired chapter prompt / the subject guide —
  this is the one piece of **authored** content in the migration, so paste it in deliberately);
- add `TLM ─covers→ Course` (the coarse scope the phase-3 reader falls back to);
- **id:** mint a deterministic UUIDv5-style id from a stable seed (e.g. `tlm:<namespace>:<courseId>`)
  using the same `derivedId` helper the other migration scripts use, so a re-run is idempotent
  and the id is stable across environments.

## Step C — (Student's Book only) build the `DocumentSection` spine

Optional but this is the document that motivates sections. For each unit the book renders
(chapter/page), create a `DocumentSection` with a `position`, `TLM ─hasPart→ DocumentSection`,
and `DocumentSection ─covers→ <curriculum node>`. Front-matter (cover, TOC) is a section with
**empty `covers`** and a low `position` — the phase-3 reader already treats an empty `covers`
as front-matter. Sections **win over** the coarse `TLM→covers→Course` hint when present
(`documentSubgraph` `scope: "sections"`), so add the coarse `covers` too as a harmless fallback.

## Step D — re-home the formatters under the TLM, drop `usesRoutine`

Now that the TLM (and any sections) exist:
- for a **doc-wide** formatter: replace its `Lesson ─usesRoutine→ Formatter` edge with
  `TLM ─hasPart→ Formatter`;
- for a **per-section** formatter (Student's Book): `DocumentSection ─hasPart→ Formatter`;
- **delete every `usesRoutine` edge** that pointed at a relabelled formatter.

After this step the curriculum walk (`hasPart`/`hasChild`) is free of formatters — they reach
generation only through the TLM, which is the whole point.

> **Non-formatter routines** (real `InstructionalRoutine` pedagogy, if any exist) keep their
> `usesRoutine` edges untouched. Only formatter-kind routines move.

---

## How to apply the transform: export → transform → import (recommended)

The store is fully re-exportable, so the safest, most reviewable path mirrors the existing
migration scripts — but reads/writes **Firestore** (there is no `sources/` any more;
firestore-only store):

```bash
cd backend && npm run build

# 1. Snapshot the live published graph (this is also your backup).
node scripts/export-kg.mjs senegal ci maths /tmp/ci-maths.before.json

# 2. Transform it with a new, deterministic, re-runnable script (Steps A–D above),
#    written against the raw { nodes, relationships } envelope like the other
#    scripts/migrate-*.mjs. Verify with --dry first.
node scripts/migrate-tlm-documents.mjs --dry     # prints the node/edge delta, writes nothing
node scripts/migrate-tlm-documents.mjs           # writes /tmp/ci-maths.after.json

# 3. Re-import the transformed graph.
node scripts/import-kg.mjs senegal ci maths /tmp/ci-maths.after.json --dry-run   # in-memory, writes nothing
node scripts/import-kg.mjs senegal ci maths /tmp/ci-maths.after.json
```

> ⚠️ **Pointer/slot gotcha.** `import-kg` writes to **slot `a`** and leaves an existing
> pointer alone (`ensurePointer` is a no-op on an existing pointer — it never moves a
> published draft). If the namespace's `publishedSlot` is currently `b`, importing to `a`
> writes the migrated graph to the **non-published** slot and nothing changes for readers.
> Before importing, check the pointer (`namespace_stats` / the store's meta) and either
> (a) import into a namespace whose published slot is `a`, or (b) instead of re-import, apply
> the transform **in place** as a two-phase mutation batch against the published slot (a live
> migration script using `runGraphMutation`), then `publish_draft`. Pick one path and confirm
> the pointer state before running — this is the single most error-prone spot.

**Whichever path:** the document nodes round-trip because the parser **excludes** DOCUMENT_LABELS
from the spine but the `rawGraph` echo re-emits them (phase 1) — so a re-import preserves them
even though they are not curriculum units.

---

## Step E — the final code step (ship WITH the data, not before)

Only once the live graph carries `Formatter` nodes under TLMs is it safe to stop the Course
walk from following `usesRoutine`:

- `backend/src/curriculum/courses.ts` — remove `"usesRoutine"` from `EXPAND_EDGES`
  (line ~26) and update the surrounding comment (lines ~22–26, ~41).
- `backend/src/curriculum/__tests__/courses.test.ts` — drop the assertions that expect a
  routine in the Course subtree.
- Re-check the catalog tools (`use_formatter`/`use_routine`/`add_to_catalog`) and
  `src/kg-recipes/catalog.ts`: authoring **new** formatters should now create `Formatter`
  nodes under a TLM, not `usesRoutine` routines under a Lesson. If those tools still attach via
  `usesRoutine`, either repoint them at the TLM in this same change or file the follow-up
  explicitly — do not leave the write path minting the very shape we just migrated away from.
- `get_capabilities` must stay an accurate mirror — update it and `capabilities.test.ts` for
  any tool-surface change.

Run the gates: `npm run typecheck && npm run check:cycles && npx vitest run` (all green).

## Step F — re-point generation + history at the TLM scope node

- **Generation** already reads via `walk_document(tlmId)` (phase 3). The remaining work is
  operational: authors/tools point at the **TLM id** as the scope node instead of the Course id.
- **History** is keyed by the covered `nodeId` (`src/storage/history.ts`). Existing entries are
  keyed by the **old Course id**; after cutover, generations log against the **TLM id**. Either
  re-key the existing history entries to the TLM id as part of the migration, or run
  `reconcile` after cutover to re-link stored documents to their new scope node. Decide which
  and note it — a mismatch shows up as "document not found in history" for already-generated docs.

## Step G — deploy

Data-only changes are picked up by a re-seed; but Phase 4 **also changes code** (Step E), so a
**Cloud Run redeploy is required** — the live server otherwise keeps the old `usesRoutine`
walk and silently misreads (see [[project_deploy_code_vs_data]]). Deploy per
[`deployment.md`](deployment.md), then **verify against the live MCP server**, not just a local
run.

---

## Verification checklist (post-cutover)

- [ ] `namespace_stats` on ci/maths lists the TLM(s) as document roots.
- [ ] `walk_document(<tlm id>)` returns `scope: "sections"` (Student's Book) / `"course"`
      (Teacher's Guide), the right `assemblyGuide`, the formatter stack, and a curriculum walk
      with **no** `Formatter`/`InstructionalRoutine` leakage.
- [ ] `walk_graph` from a Lesson shows **no** `usesRoutine → formatter` edges remaining.
- [ ] The KG explorer's Documents view (phase 2) shows each TLM with `covers` on its own axis.
- [ ] A `preview_generation` off the draft still produces a document (the editing loop is intact).
- [ ] `export-kg` of the migrated namespace re-imports cleanly (`import-kg --dry-run`) — the
      round-trip still holds.

## Rollback

The `/tmp/ci-maths.before.json` snapshot from Step A is a complete, importable graph. To
revert the **data**, re-import it (minding the same pointer/slot gotcha). To revert the
**code**, redeploy the pre–Step-E build. Roll back code and data **together** — the new code
expects the migrated shape and vice-versa.
