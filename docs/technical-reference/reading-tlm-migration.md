# CE1 reading — content canonicalisation + TLM cutover (runbook)

**Status:** dev-box pieces landed + verified against the fixture; **live data
migration + deploy pending creds.** This brings CE1 reading to the same shape maths
already has (see [`tlm-phase4-migration.md`](tlm-phase4-migration.md) and
[`../design-notes/teaching-learning-materials.md`](../design-notes/teaching-learning-materials.md)):
a document is a `TeachingLearningMaterial` (TLM) that `covers` a curriculum `Course`,
formatters hang off the TLM (never a Course `usesRoutine`), and the content nests as
the canonical `LessonGrouping → Lesson → Activity`.

## What changes

Data (one script, `scripts/migrate-reading-tlm.mjs`, on an exported graph):

1. **Content canonicalisation.** Each session `Lesson` → `Activity`; each `Jour`
   day-grouping (`LessonGrouping`) → `Lesson`. Result: `Semaine (LessonGrouping) →
   day (Lesson) → session (Activity)`. Every edge is kept — a session keeps its
   `hasEducationalAlignment` to its skill-area standard and its `usesRoutine` to its
   routine, and on an `Activity` both are the canonical edges.
2. **TLM document model** (the maths Steps A/B/D): relabel the 4 formatter
   `InstructionalRoutine`s → `Formatter` (+ their `Material` specs → `FormatterSpec`);
   mint a `TeachingLearningMaterial` "Guide de l'enseignant" that `covers` the Course;
   re-home the 4 formatters under the TLM via `hasPart` and **delete the 4 Course
   `usesRoutine` formatter edges** — so no formatter rides `usesRoutine` any more.
3. **Rename the Course** "Guide de l'enseignant" → **"Planification"** (curriculum and
   deliverable are now separate nodes).

Code (needs a Cloud Run redeploy):

- `src/curriculum/prunes.ts` — the reading prune keeps a standard when a kept aligned
  child is a `Lesson` **or** an `Activity` (a canonicalised session is an `Activity`).
  **Backward-compatible** (still accepts `Lesson`), so it is safe to deploy *before*
  the data migrates — the old live data keeps parsing identically.
- `assets/senegal/ce1/reading/GRAPH_GUIDE.md` — rewritten for the new shape + the
  TLM-based document model. `import-kg` writes this into the published config cell, so
  the guide updates **atomically with the graph** (no separate `edit_profile`).

Verified on the dev box: full suite 501 green; the migrated fixture parses with **all
1275 units and every skill-area standard retained** (462 `Lesson`→`Activity`, 105
`Jour`→`Lesson`); the script is idempotent (a second run bails).

## Preconditions

1. **Land the code** (script + `prunes.ts` + guide + the `import-kg --replace-published`
   flag) on `main`.
2. **Creds/env** (same as the server, so the namespace lines up):
   `SERVICE_ACCOUNT_KEY_PATH` (or `SERVICE_ACCOUNT_KEY_JSON`), `FIREBASE_STORAGE_BUCKET`,
   `TLM_BUCKET_PREFIX`. `gcloud auth login` if the deploy uses your user identity.
3. `cd backend && npm run build` (the import/export scripts import from `dist/`, and the
   deploy ships the compiled `prunes.ts`).
4. **Freeze writes** on `senegal/ce1/reading` during the window — no curator editing
   while the graph is transformed and re-imported. (`migrate-reading-tlm.mjs` and
   `import-kg --replace-published` both refuse to clobber an open draft, but a curator
   editing mid-cutover would still lose that edit.)

## Order matters — deploy the code FIRST, then the data

The new data (sessions as `Activity`) needs the new prune to retain standards. Because
the prune change is backward-compatible, **deploy first is safe** (old live data still
parses) and closes the window where new data could meet old code:

### 1. Deploy the code

Redeploy Cloud Run from the merged `main` per [`deployment.md`](deployment.md). Verify
against the **live MCP server** (not just a local run) that reading still reads
correctly — the old data is unchanged, so `namespace_stats` / a week walk should look
exactly as before.

### 2. Migrate + re-import the data

```bash
cd backend && npm run build

# a. Snapshot the live published graph (also your rollback backup).
node scripts/export-kg.mjs senegal ce1 reading /tmp/ce1-reading.before.json

# b. Transform it. --dry first; the summary should read ~462 sessions→Activity,
#    ~105 days→Lesson, 4 formatters relabelled, 1 TLM minted, 4 usesRoutine edges
#    deleted, Course renamed. Pass --guide to re-author the TLM's assemblyGuide;
#    omit it to use the good default baked into the script.
node scripts/migrate-reading-tlm.mjs --in /tmp/ce1-reading.before.json --dry
node scripts/migrate-reading-tlm.mjs \
  --in /tmp/ce1-reading.before.json --out /tmp/ce1-reading.after.json \
  --namespace senegal:ce1:reading

# c. Re-import. --dry-run first (in-memory, parses via the adapter, writes nothing).
node scripts/import-kg.mjs senegal ce1 reading /tmp/ce1-reading.after.json --dry-run

# d. Write it LIVE, in place, on the published slot. reading's published slot is 'b',
#    so a plain import (slot 'a') would NOT go live — --replace-published overwrites
#    the live slot directly (it refuses if a draft is open). This also writes the
#    rewritten guide into the published config cell.
node scripts/import-kg.mjs senegal ce1 reading /tmp/ce1-reading.after.json --replace-published
```

> ⚠️ **Why `--replace-published`.** Plain `import-kg` writes slot `a` and leaves the
> pointer; reading's published slot is `b`, so that would land on the non-published
> slot and change nothing for readers. `--replace-published` writes the currently
> published slot in place. (Maths did its cutover live via the curator loop, so it
> never hit this; a re-import into any `published=b` namespace would.)

## Verification checklist (post-cutover, against the LIVE MCP server)

- [ ] `namespace_stats` on ce1/reading shows a `TeachingLearningMaterial` and a
      `Formatter`/`FormatterSpec` count of 4/4 (or as authored); `Activity` ≈ 462,
      the `Course` renamed to **Planification**.
- [ ] `usesRoutine` edges no longer point at any `Formatter` — walk the Course out via
      `usesRoutine` and confirm **zero** formatter targets (only session→routine remain).
- [ ] A week walk reads `Semaine → Lesson (Jour N) → Activity (session)`, and
      `get_standards(<a session Activity>)` still returns its skill-area standard
      (proves the prune retained standards).
- [ ] The TLM `covers` the Planification Course; its 4 formatters hang off it via
      `hasPart`.
- [ ] `get_graph_guide` returns the rewritten guide (day = `Lesson`, session =
      `Activity`, formatters on the TLM).
- [ ] `export-kg` of the migrated namespace re-imports cleanly (`import-kg --dry-run`).

## Rollback

`/tmp/ce1-reading.before.json` is a complete, importable graph. To revert the **data**,
re-import it with `--replace-published`. The **code** (prune) is backward-compatible, so
it does not need a rollback to read the old data — but roll code and data back together
if you revert, to keep the guide and shape in step.
