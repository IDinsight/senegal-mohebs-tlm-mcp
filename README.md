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

Each grade/subject is a folder holding the same canonical filenames. Add a subject by dropping in a new folder:

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

## Configuration

Required:
- `SERVICE_ACCOUNT_KEY_PATH` — path to your Firebase service-account JSON (used for auth **and** for signing upload URLs).
- `FIREBASE_STORAGE_BUCKET` — the bucket name, e.g. `your-project.appspot.com`.

Optional:
- `TLM_GRADE` / `TLM_SUBJECT` — pre-select the active grade/subject at startup, so you don't have to call `set_context` first. Must match an installed folder pair.
- `TLM_BUCKET_PREFIX` — put everything under a prefix (e.g. `pilot` → `pilot/ci/maths/documents/…`, `pilot/ci/maths/history.json`). The grade/subject scope is always appended after the prefix.
- `TLM_SOURCES_DIR` and per-file overrides (`TLM_KG_FILE`, `TLM_TERMINOLOGY_FILE`, `TLM_CHAPTER_PROMPT`, `TLM_LESSONS_PROMPT`, `TLM_EXAMPLE_DOMAINS`). Overrides are basenames resolved inside the active `<grade>/<subject>` folder.
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
Document identity is `chapter:type` (e.g. `5:manual`, `5:lessons`) **within a grade/subject**; the chapter number is the first integer in the subfolder name, and a file named "Fiches de leçons …" is the lesson-sheets doc (anything else is the manual).

## The generation flow (cross-host, no shared disk)

0. `set_context(grade, subject)` — pick what you're working on. `get_context` lists the installed pairs and the current selection.
1. `get_generation_context(chapter, docType)` — curriculum slice, established characters, terminology guidance, coverage, and (for lessons) the manual to build on. For example-domain variety it returns `exampleDomains: { suggested, avoidNearby }`: `suggested` is a fresh object family to use, and `avoidNearby` maps each *nearby* chapter number (within ±`TLM_DOMAIN_NEIGHBORHOOD_K`) to the domains it used — so adjacent chapters don't repeat the same family. This is a bounded window, not the whole book; use `domain_usage` for the full log.
2. Generate the `.docx`.
3. `create_upload_url(relPath)` → the server returns a short-lived **signed URL**. Upload the file with an HTTP `PUT` (Content-Type `application/vnd.openxmlformats-officedocument.wordprocessingml.document`). No large payloads go through the MCP channel.
4. `log_generation(chapter, type, relPath, content)` — the server reads the uploaded object's md5 from storage and records what you produced. History updated; no local file needed.

## Ingesting a doc authored elsewhere (e.g. an expert wrote chapter 2)

1. The file is in the bucket (uploaded any way you like), under the grade/subject's `documents/`.
2. `reconcile` surfaces it as untracked.
3. `get_document_text(relPath)` returns its plain text (server downloads from the bucket and extracts via mammoth — it never calls an LLM).
4. Extract the structured content and call `record_document_content(...)`. Tracked from then on.

## Reconciliation

Run on startup (when a context is active) and via the `reconcile` tool: present + md5 matches history → tracked (skipped); new/changed md5 → untracked (needs ingestion); in history but gone from the bucket → dropped; duplicates for one identity → the object matching the tracked md5 wins, else most-recently-updated.

## Tools

Context: `set_context`, `get_context`.

Per grade/subject: `list_chapters`, `get_curriculum`, `get_terminology`, `terminology_sections`, `get_prompt`, `get_generation_context`, `suggest_fresh_domain`, `domain_usage`, `reconcile`, `list_documents`, `create_upload_url`, `create_download_url`, `get_document_text`, `record_document_content`, `log_generation`.

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

## Testing note

The storage layer sits behind a small `StorageAdapter` interface. The reconcile / history / variety / ingest logic is verified against an in-memory fake (no credentials needed). Unit tests run with `npm test` (Vitest); the example-domain neighborhood/suggestion logic is covered in `src/generation/domains.test.ts`. The **Firebase implementation is compile-checked but not live-tested here** — validating real bucket calls (list, signed URL, download, history read/write) needs your service-account credentials and network access, so do a first run against your own project.

## Assumptions still baked in (tell me to change any)

- One grade/subject is active at a time; switching drops the KG, terminology, and history caches so the next call reloads for the new context.
- The chapter (pupil-manual) filename is inferred: within a chapter subfolder, anything not "Fiches de leçons …" is the manual.
- Glossary derives from the KG, with the FR/Wolof file as fallback; characters are derived from what you log/ingest.
- "Latest" among duplicates is the object whose md5 matches history, else the most recently updated.
