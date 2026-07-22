# senegal-mohebs-tlm-server

An MCP server that gives the Senegalese **MOHEBS** teaching & learning materials pipeline a **shared memory layer** — so AI-generated documents stay consistent (characters, terminology, concept coverage) and deliberately varied (rotating example domains — fruits → legumes → …), across **any grade and subject**.

The server works on one **grade + subject** at a time (e.g. `ci` / `maths`). You pick the pair with `set_context`; that choice selects which local sources load and which Firebase namespace the documents and history live under. Until a pair is set, the source- and bucket-dependent tools return a short "choose a grade/subject first" prompt instead of running.

**Firebase Storage is the shared source of truth** for generated documents and the history file. The generating agent, the server, and you no longer need to share a disk: everything reads and writes the same bucket. **Sources** (knowledge graph, terminology, prompts) stay **local** to the server as read-only inputs you edit in place.

## What lives where

| Thing | Location |
|---|---|
| Knowledge graph, terminology, the two prompts | **Local** `sources/<grade>/<subject>/` (you edit these) |
| Generated `.docx` (chapter manuals + lesson sheets) | **Firebase** `<grade>/<subject>/documents/chapitre_NN/…` |
| History / tracker (`history.json`) | **Firebase** `<grade>/<subject>/history.json` |

Object hashing uses the GCS object **md5** from metadata — the server never hashes a local file, which is what removes the cross-host mismatch that broke `log_generation` before.

## Sources layout

Each grade/subject is a folder holding the same canonical filenames:

```
sources/
  ci/
    maths/
      knowledge_graph.json
      terminology.json
      PROMPT_generate_chapter.md
      PROMPT_generate_lessons.md
      example_domains.json        # optional; falls back to a built-in pool
  ce1/
    lecture/
      …
```

`get_context` discovers these by scanning the tree, so the installed pairs are whatever folders exist.

> **Note.** Dropping in a folder provides the *data* for a grade/subject. Wiring it up so the tools actually work also needs a registered **profile** (and, if its knowledge-graph shape differs from an existing subject, a curriculum **adapter**). A folder with no registered profile is rejected by `set_context`. See [Adding a new grade/subject](#adding-a-new-gradesubject).

## Configuration

Required:
- `SERVICE_ACCOUNT_KEY_PATH` — path to your Firebase service-account JSON (used for auth **and** for signing upload URLs).
- `FIREBASE_STORAGE_BUCKET` — the bucket name, e.g. `your-project.appspot.com`.

Optional:
- `TLM_GRADE` / `TLM_SUBJECT` — pre-select the active grade/subject at startup, so you don't have to call `set_context` first. Must match an installed folder pair.
- `TLM_BUCKET_PREFIX` — put everything under a prefix (e.g. `pilot` → `pilot/ci/maths/documents/…`, `pilot/ci/maths/history.json`). The grade/subject scope is always appended after the prefix.
- `TLM_SOURCES_DIR` — relocate the sources root (defaults to `./sources`). The per-subject filenames inside each `<grade>/<subject>` folder are fixed conventions: `knowledge_graph.json`, `terminology.json`, optional `example_domains.json`, and the prompt `.md` files (each subject's profile names its own prompt files via `DeliverableSpec.promptFile`).
- `TLM_DOMAIN_NEIGHBORHOOD_K` — how many chapters on each side count as a chapter's "neighborhood" for example-domain variety (default `3`). `get_generation_context` only reports the domains used by chapters within ±K of the target (by chapter number), and its fresh-domain suggestion avoids anything in that window. Larger K = stronger variety across a wider span; the payload stays bounded by the window regardless of how many chapters are authored.

## Bucket layout

```
gs://<FIREBASE_STORAGE_BUCKET>/
  <grade>/<subject>/
    documents/
      chapitre_05/<Manuel …>.docx
      chapitre_05/<Fiches de leçons …>.docx
    history.json
```
Document identity is `scope:deliverable` (e.g. `5:manual`, `5:lessons`) **within a grade/subject**; the scope is the first integer in the subfolder name, and the active subject's profile classifies the filename into a deliverable (for maths: a file named "Fiches de leçons …" is the lesson-sheets doc, anything else is the manual).

## The generation flow (cross-host, no shared disk)

0. `set_context(grade, subject)` — pick what you're working on. `get_context` lists the installed pairs and the current selection.
1. `get_generation_context(unit, deliverable)` — curriculum slice, established characters, terminology guidance, coverage, and (for the teacher guide) the manual to build on. `unit` is the scope value (for maths, the chapter number) and `deliverable` is a deliverable key (`manual`/`lessons`). For example-domain variety it returns `exampleDomains: { suggested, avoidNearby }`: `suggested` is a fresh object family to use, and `avoidNearby` maps each *nearby* chapter number (within ±`TLM_DOMAIN_NEIGHBORHOOD_K`) to the domains it used — so adjacent chapters don't repeat the same family. This is a bounded window, not the whole book; use `domain_usage` for the full log.
2. Generate the `.docx`.
3. `create_upload_url(relPath)` → the server returns a short-lived **signed URL**. Upload the file with an HTTP `PUT` (Content-Type `application/vnd.openxmlformats-officedocument.wordprocessingml.document`). No large payloads go through the MCP channel.
4. `log_generation(unit, deliverable, relPath, content)` — the server reads the uploaded object's md5 from storage and records what you produced. History updated; no local file needed.

## Ingesting a doc authored elsewhere (e.g. an expert wrote chapter 2)

1. The file is in the bucket (uploaded any way you like), under the grade/subject's `documents/`.
2. `reconcile` surfaces it as untracked.
3. `get_document_text(relPath)` returns its plain text (server downloads from the bucket and extracts via mammoth — it never calls an LLM).
4. Extract the structured content and call `record_document_content(...)`. Tracked from then on.

## Reconciliation

Run on startup (when a context is active) and via the `reconcile` tool: present + md5 matches history → tracked (skipped); new/changed md5 → untracked (needs ingestion); in history but gone from the bucket → dropped; duplicates for one identity → the object matching the tracked md5 wins, else most-recently-updated.

## Tools

**Context (subject-agnostic):** `set_context`, `get_context`.

**Subject-agnostic** — work the same for any grade/subject: `get_terminology`, `terminology_sections`, `get_prompt`, `reconcile`, `list_documents`, `create_upload_url`, `create_download_url`, `get_document_text`.

**Subject-specific payloads** — generically named, but what they accept/return is shaped by the active subject's profile:

- `list_units`, `get_curriculum`, `get_generation_context`, `record_document_content`, `log_generation`. These take a `unit` (the subject's scope value — a chapter for maths, a week for CE1 reading) and, where relevant, a `deliverable` key. The shapes are subject-specific: maths returns `chapitreNum`/`leconNum` etc., and the `content` payload (characters, example domains, amorce/bilan) follows the maths storybook model — all fields optional.
- *Capability-specific* (`exampleDomainRotation`, maths only) — `suggest_fresh_domain`, `domain_usage`. Example-domain rotation is a maths storybook feature; they are gated on the capability, so for a subject whose profile doesn't enable it they return a `notApplicable` message instead of running.

## Setup

```bash
npm install
npm run build
```


### Wiring into a host (e.g. Claude Desktop)

```jsonc
{
  "mcpServers": {
    "senegal-mohebs-tlm": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "SERVICE_ACCOUNT_KEY_PATH": "/absolute/path/to/serviceAccount.json",
        "FIREBASE_STORAGE_BUCKET": "your-project.appspot.com",
        "TLM_SOURCES_DIR": "/absolute/path/to/sources",
        "TLM_GRADE": "ci",
        "TLM_SUBJECT": "maths"
      }
    }
  }
}
```

`TLM_GRADE`/`TLM_SUBJECT` are optional — omit them and the agent picks a pair with `set_context` at the start of a session.

## Architecture

The server supports many grades/subjects whose curriculum graphs and deliverables genuinely differ (CI maths is a `graph[]` of `Chapitre`/`OS` nodes; CE1 reading is `nodes`/`relationships` with a `hasChild` tree and no chapters). Behaviour is therefore **pluggable per subject**, not hard-coded:

- **Curriculum adapter** (`src/curriculum/adapters/*`) — parses a subject's raw knowledge graph into a normalized `CurriculumModel`, and exposes a `detect()` guard so a graph that doesn't match its schema is refused at `set_context` instead of silently mis-parsed.
- **Subject profile** (`src/profiles/*`) — declares the subject's deliverables (filenames, scope, dependencies), its capabilities, and how to build the pre-generation context. A registry in `src/profiles/index.ts` binds each `(grade, subject)` to its profile.

Modules are **layered, and imports only ever point down**. A build-time check (`npm run check:cycles`, run automatically by `npm run build`) fails on any import cycle:

```
app       server/* · index.ts · activate.ts
profiles  profiles/*                                     — compose the services below, per subject
services  storage/* · curriculum/* · generation/*        — never import profiles
core      config.ts · types.ts · context/{state,shared} · utils/*   — leaves
```

Cross-module imports go through each module's `index.ts` (barrel); files **inside** a module import their siblings directly. `activate.ts` (resolve the profile → run the schema guard → bind the context) is app-layer glue that wires `context/` to `profiles/`, so it lives at the root next to `index.ts` rather than inside the leaf `context/` module. The full design rationale is in [`docs/multi-subject-architecture.md`](docs/multi-subject-architecture.md).

## Adding a new grade/subject

Adding a subject takes its **sources** (data) and a **profile** (code). If the knowledge-graph shape differs from every existing adapter, it also needs a new **adapter**.

1. **Drop in the sources** under `sources/<grade>/<subject>/`: `knowledge_graph.json`, `terminology.json`, the generation prompt(s), and optionally `example_domains.json`.

2. **Reuse or write a curriculum adapter** (`src/curriculum/adapters/`):
   - *Same graph shape as an existing subject* (e.g. the CI-maths `graph[]` envelope) → reuse that adapter.
   - *Different shape* → add `src/curriculum/adapters/<name>.ts` implementing `CurriculumAdapter`: `detect(raw)` (the schema guard) and `parse(raw)` → `CurriculumModel`, plus a factory returning a `SubjectCurriculum` (`listUnits` / `slice` / `progression` / `requiredCoverage` / `scopeValues`). Export it from `src/curriculum/index.ts`.

3. **Write the profile** in `src/profiles/<subject>.ts` — a `buildProfile(grade, subject): SubjectProfile` providing:
   - `curriculum` — from your adapter;
   - `deliverables` — one `DeliverableSpec` per document kind (`key`, `label`, `scopeKind`, `classify(filename)`, `dependsOn`, `promptFile`);
   - `capabilities` — feature flags (e.g. `exampleDomainRotation`, `characterConsistency`);
   - `buildGenerationContext(scope, deliverableKey)` — the pre-generation payload for that subject.

4. **Register it** in `src/profiles/index.ts` under the `"<grade>/<subject>"` key.

5. **Build and select it:** `npm run build`, then `set_context("<grade>", "<subject>")`. The guard runs your adapter's `detect()` against the KG; on a mismatch it refuses to activate and says why — nothing is silently mis-parsed.

**Rules the build enforces:** imports point *down* the layers above; **service modules (`storage`/`curriculum`/`generation`) must not import `profiles`** — pass what they need in as arguments (as `reconcile(deliverables)` and `discoverDocuments(deliverables)` do); cross-module imports go through the module's `index.ts`. `npm run check:cycles` fails the build on any import cycle.

> A worked example is pending for **CE1 reading** (scope: one teacher guide **per week**); see `docs/multi-subject-architecture.md` §9/§11 for the remaining steps.

## Testing note

The storage layer sits behind a small `StorageAdapter` interface. The reconcile / history / variety / ingest logic is verified against an in-memory fake (no credentials needed). Unit tests run with `npm test` (Vitest); the example-domain neighborhood/suggestion logic is covered in `src/generation/domains.test.ts`. `npm run build` runs the import-cycle check (`npm run check:cycles`) before `tsc`, so a broken layer boundary fails the build. The **Firebase implementation is compile-checked but not live-tested here** — validating real bucket calls (list, signed URL, download, history read/write) needs your service-account credentials and network access, so do a first run against your own project.

## Assumptions still baked in (tell me to change any)

- One grade/subject is active at a time; switching drops the KG, terminology, and history caches so the next call reloads for the new context.
- Deliverable classification is per-subject (a profile's `DeliverableSpec.classify`). For CI maths: within a chapter subfolder, anything not "Fiches de leçons …" is the pupil manual.
- Glossary derives from the KG, with the FR/Wolof file as fallback; characters are derived from what you log/ingest.
- "Latest" among duplicates is the object whose md5 matches history, else the most recently updated.
