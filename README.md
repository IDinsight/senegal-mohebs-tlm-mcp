# senegal-mohebs-tlm-server

An MCP server that gives the Senegalese **MOHEBS** teaching-materials pipeline a **shared memory layer** — so AI-generated documents stay consistent (characters, terminology, concept coverage) and deliberately varied (rotating example domains: fruits → legumes → …), across **any grade and subject**.

It works on one **grade + subject** at a time (e.g. `ci` / `maths`); you pick the pair with `set_context`. **Sources** (knowledge graph, terminology, prompts) are **local**, read-only inputs you edit in place. Generated `.docx` files and their history live in **Firebase Storage** (the shared source of truth, so the generating agent, the server, and you never need a shared disk). Curriculum data can additionally live in a **Firestore node/edge store** with a draft → review → publish curator loop. Auth is a Supabase JWT.

> **Going deeper:** the full operational manual is [`docs/technical-reference.md`](docs/technical-reference.md); the architecture summary + working conventions are in [`CLAUDE.md`](CLAUDE.md); the production runbook is [`DEPLOY.md`](DEPLOY.md).

## What lives where

| Thing | Location |
|---|---|
| Knowledge graph, terminology, the two prompts | **Local** `sources/<grade>/<subject>/` (you edit these) |
| Generated `.docx` (manuals + lesson sheets) + `history.json` | **Firebase Storage** `<grade>/<subject>/…` |
| Curriculum node/edge store (optional) | **Firestore** (`KG_SOURCE=firestore`) |

Object hashing uses the GCS object **md5** from metadata — the server never hashes a local file, which removes the cross-host mismatch that used to break `log_generation`.

## Sources layout

Each grade/subject folder holds the same canonical filenames:

```
sources/ci/maths/
  knowledge_graph.json          # { nodes, relationships } — converged LC metadata scheme
  terminology.json
  PROMPT_generate_chapter.md
  PROMPT_generate_lessons.md
  example_domains.json          # optional; falls back to a built-in pool
```

`get_context` discovers installed pairs by scanning the tree. Dropping in a folder provides the *data*; making the tools work also needs a registered **adapter** (`src/adapters/`, one behavior module per subject) — a folder with no adapter is rejected by `set_context`. See [Adding a grade/subject](docs/technical-reference.md#adding-a-new-gradesubject).

## Quickstart

```bash
npm install
npm run build          # check-cycles (layering) + tsc → dist/
npm test               # vitest
npm start              # stdio MCP server (dist/index.js)
npm run start:http     # HTTP MCP server (dist/http.js) — remote / Cloud Run
```

**Required env:** `SERVICE_ACCOUNT_KEY_PATH` (Firebase service-account JSON) · `FIREBASE_STORAGE_BUCKET`.

**Common optional env:** `TLM_GRADE` / `TLM_SUBJECT` (pre-select a pair at startup) · `TLM_BUCKET_PREFIX` (namespace everything under a prefix) · `TLM_SOURCES_DIR` · `KG_SOURCE` (`bundle` default | `firestore`) · `TLM_DOMAIN_NEIGHBORHOOD_K`. Full list and semantics: [technical reference → Configuration](docs/technical-reference.md).

## Firestore KG store + curator loop (optional)

Curriculum + KG data can live in a generic Firestore node/edge store with a **double-buffered draft/published** model and a curator/approver **edit → review → publish** loop (wording edits via `upsert_property`, structural changes via composite recipes `add_lesson`/`add_chapter`/`move_lesson`/`split_chapter`/`renumber`, all two-phase-confirmed and audited). Seed and verify:

```bash
KG_SOURCE=firestore npm run seed:kg-store       # seed Firestore from sources/
KG_SOURCE=firestore npm run parity:kg-store     # assert firestore reads == bundle reads
```

Full lifecycle, roles, recipes, integrity rules, and audit: [technical reference → KG node/edge store](docs/technical-reference.md#kg-nodeedge-store).

## The generation flow (in brief)

1. `set_context(grade, subject)` — pick what you're working on.
2. `get_generation_context(unit, deliverable)` — curriculum slice, established characters, terminology, coverage, fresh example-domain suggestion.
3. Generate the `.docx`.
4. `create_upload_url(relPath)` → `PUT` the file to the signed URL (no large payloads through MCP).
5. `log_generation(unit, deliverable, relPath, content)` — records what you produced (md5 read from storage).

The outward-writing tools (`create_upload_url`, `log_generation`, `record_document_content`) are gated by a confirmation step. Details, preview generation, ingestion, and reconciliation: [technical reference](docs/technical-reference.md#the-generation-flow-cross-host-no-shared-disk).

## Tools

- **Context:** `set_context`, `get_context`.
- **Subject-agnostic:** `get_terminology`, `terminology_sections`, `get_prompt`, `reconcile`, `list_documents`, `create_upload_url`, `create_download_url`, `get_document_text`, `get_capabilities`.
- **Curator loop (role-gated):** `diff_draft`, `upsert_property`, `create_node`/`link_nodes`/`unlink_nodes`/`delete_node`, `add_lesson`/`add_chapter`/`move_lesson`/`split_chapter`/`renumber`, `publish_draft`, `discard_draft`, `read_audit`.
- **Subject-shaped payloads:** `list_units`, `get_curriculum`, `get_generation_context`, `record_document_content`, `log_generation`, `preview_generation`, `create_preview_upload_url`, and (CI maths only) `suggest_fresh_domain`, `domain_usage`.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — architecture summary, module layering, conventions (the working guide).
- [`docs/technical-reference.md`](docs/technical-reference.md) — the full operational manual: KG store & curator loop, integrity/audit, the read-only KG explorer, buckets, generation/preview flow, deployment & hosting.
- [`DEPLOY.md`](DEPLOY.md) — production deployment runbook.
- Design notes: [multi-subject architecture](docs/multi-subject-architecture.md) · [KG mutations framework](docs/kg-mutations-framework.md) · [preview generation](docs/preview-generation-findings.md) · [KG explorer findings](docs/kg-explorer-findings.md) · [read-audit findings](docs/read-audit-findings.md).
