---
name: seed-and-deploy
description: Roll out a change to the Firestore KG store or the deployed MCP server and verify it — import/export a whole graph, edit a subject profile or guide through the live curator loop, deploy new server code, or repair a namespace. Use whenever importing/exporting a KG, changing a profile/guide, coordinating a data or code change with a Cloud Run deploy, or fixing a store namespace. (There is no `seed:kg-store` / seed-from-`sources/` step any more — Firestore is the only store.)
---

# Roll out a KG-store or server change safely

**Firestore is the only KG store.** There is no `bundle`/`KG_SOURCE` mode, no
`seed:kg-store`, and no seed-from-`sources/` step — all removed with the
firestore-only change (see
[`docs/design-notes/firestore-only-store.md`](../../docs/design-notes/firestore-only-store.md)
and [`docs/technical-reference/store.md`](../../docs/technical-reference/store.md)).
The graphs now live under `backend/test/fixtures/` (tests only) and in Firestore (live); the
per-subject `backend/assets/<ws>/<grade>/<subject>/` (terminology + prompt files) ship in the
container image. **The server is a self-contained package under `backend/` — run every
`npm run …` command in this skill from `backend/`** (`cd backend` first).

## Pick the path by what changed

| What you're changing | Path | Redeploy? |
|---|---|---|
| **Curriculum content, a subject profile, or a graph guide** | The **live curator loop** — edit with the graph tools / `edit_profile`, then `diff_draft` → `publish_draft`. Nothing reaches generation until you publish. | **No** |
| **A whole graph** (new namespace, restore from backup, clone) | `export:kg-store` (back up first) then `import:kg-store` | No (data only) |
| **A new subject** | Register its profile under `backend/src/adapters/profiles/` (**code**) → deploy → `import:kg-store` its graph | Yes (the profile is code) |
| **Server code** (parser, adapter engine, tools) | Cloud Run deploy (see [`DEPLOY.md`](../../DEPLOY.md)) | Yes |

The common case — tweaking a guide, fixing a lesson, editing a profile — is a **data
change through the curator loop, live, with no redeploy and no import.** Reach for
`import:kg-store` only to move a *whole graph*.

## The one coupling that still bites: code vs. store shape

The store holds the *full* Learning-Commons graph (spine + framework/derived nodes +
the real `supports`/`relatesTo` edges). The server must run code that reads that shape
(`toRawEnvelope` + `adapter.parse` hydration). An **older** server pointed at the store
silently drops content it can't read — no crash, just missing components/tasks in the
output. **Rule: when the code that reads the graph changes, deploy it before or with the
data it will read.** Pure data changes (curator loop, import) don't need a redeploy.

## Import / export (whole-graph moves)

These scripts run from `dist/` and hit real Firestore. Prerequisites in the shell:

- `SERVICE_ACCOUNT_KEY_PATH` — path to the Firebase service-account JSON
- `FIREBASE_STORAGE_BUCKET`

(No `KG_SOURCE`. On Cloud Run there is no key path — the runtime service account
supplies credentials.) Never print or commit the key.

```bash
npm run build                                                          # scripts read dist/
npm run export:kg-store -- <ws> <grade> <subject> [out.json]          # back up first
npm run import:kg-store -- <ws> <grade> <subject> <graph.json> [--profile p.json] [--dry-run]
```

`import-kg` writes the graph **and** the subject-profile config cell — from `--profile
<path>` (`{ core, guide }` JSON) when given, otherwise the in-repo literal for that
grade/subject.

> **⚠️ import writes slot `a` and never repoints an existing namespace.** The store is
> double-buffered (`a`/`b`) behind a pointer `{ publishedSlot, draftSlot }`. On a
> **new** namespace, import stamps the pointer to `a`. On an **existing** one it prints
> `WARNING — namespace already exists … writing slot 'a' and leaving the pointer as-is`
> and writes `a` regardless. So if the published slot is `b`, a re-import lands in a
> **side-copy nothing reads.** Read the script's output; if you need the imported data
> published, publish it through the curator loop (which flips the pointer), not by
> re-running import.

## Verify after any store change

Against the deployed server (via the MCP tools):

1. `set_context <ws> <grade> <subject>` **activates** (an invalid stored profile refuses
   activation — see recovery below).
2. `namespace_stats` / `walk_graph` return the expected node/edge counts.
3. `get_graph_guide` returns the intended guide text (for a profile/guide change).

## Deploy the server

Full command + env live in [`DEPLOY.md`](../../DEPLOY.md). After deploy, smoke-check:

```bash
curl -s https://<service-url>/health     # → ok   (NOT /healthz — Google reserves that path)
```

## Recovery: a config cell too invalid to activate

If `set_context` fails with *"the stored subject profile … is invalid and would
mis-parse"*, the published config cell is malformed for the running code (e.g. it
carries a key the current schema retired). This is a **chicken-and-egg**: `edit_profile`
can't fix it because it needs the context activated, and `import:kg-store` only writes
slot `a` (so it fixes the published cell only if the published slot *is* `a`). Options,
in order of preference:

1. **If published slot is `a`:** `import:kg-store … --profile <clean.json>` (or the
   clean in-repo literal) rewrites the published cell.
2. **If published slot is `b`:** there is no clean CLI for a targeted repair today —
   this is a known gap. Either add a one-off script that writes the config cell to the
   published slot, or (destructive, loses history/drafts) `delete-namespace` then
   re-import.

Determining the published slot needs store access (the pointer doc) — check it before
choosing.
