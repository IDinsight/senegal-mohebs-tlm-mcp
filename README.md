# senegal-mohebs-tlm-server

An MCP server that gives the Senegalese **MOHEBS** teaching-materials pipeline a **shared memory layer** — so AI-generated documents stay consistent (characters, terminology, concept coverage) and deliberately varied (rotating example domains: fruits → legumes → …), across **any grade and subject**.

It works on one **grade + subject** at a time (e.g. `ci` / `maths`); you pick the pair with `set_context`. The **knowledge graph lives in a Firestore node/edge store** — the single source of truth — with a draft → review → publish curator loop; you add a graph with `import-kg` and back it up with `export-kg`. Generated `.docx` files and their history live in **Firebase Storage** (so the generating agent, the server, and you never need a shared disk). The only local per-subject input is the `terminology.json` glossary fallback (under `assets/`). Auth is a Supabase JWT.

> **Going deeper:** the full operational manual is [`docs/technical-reference/`](docs/technical-reference/); the architecture summary + working conventions are in [`CLAUDE.md`](CLAUDE.md); the production runbook is [`DEPLOY.md`](DEPLOY.md).

## What lives where

| Thing | Location |
|---|---|
| Knowledge graph (curriculum) | **Firestore** node/edge store — the source of truth (`import-kg` / `export-kg`) |
| `terminology.json` glossary fallback | **Local** `assets/<workspace>/<grade>/<subject>/` |
| Generated `.docx` (manuals + lesson sheets) + `history.json` | **Firebase Storage** `<grade>/<subject>/…` |

Object hashing uses the GCS object **md5** from metadata — the server never hashes a local file, which removes the cross-host mismatch that used to break `log_generation`.

## Where the graph lives

The knowledge graph is **only** in the Firestore store — there is no on-disk `sources/` copy and no `KG_SOURCE` toggle (see [firestore-only-store](docs/design-notes/firestore-only-store.md)). Add a graph on demand:

```bash
npm run import:kg-store -- <workspace> <grade> <subject> path/to/knowledge_graph.json
```

The JSON is a raw Learning-Commons envelope (`{ nodes, relationships }`). `get_context` discovers installed pairs from the **store** (the namespaces that have a graph). Making the tools work also needs a registered **subject profile** (`src/adapters/profiles/`, one declarative literal per subject) — a namespace with no registered adapter is rejected by `set_context`. See [Adding a grade/subject](docs/technical-reference/architecture-and-extending.md#adding-a-new-gradesubject).

The only per-subject files on disk are static assets under `assets/<workspace>/<grade>/<subject>/` — currently just the optional `terminology.json` (FR/Wolof glossary fallback). Realistic graphs for the test suite live under `test/fixtures/` as committed test data.

## Quickstart

The server is a self-contained package under **`backend/`** (the `frontend/` explorer UI is its own package). Run these from `backend/`, and read the `assets/…`, `test/…`, `src/…` paths elsewhere in this README as relative to it.

```bash
cd backend
npm install
npm run build          # check-cycles (layering) + tsc → dist/
npm test               # vitest
npm start              # stdio MCP server (dist/index.js)
npm run start:http     # HTTP MCP server (dist/http.js) — remote / Cloud Run
```

**Required env:** `SERVICE_ACCOUNT_KEY_PATH` (Firebase service-account JSON) · `FIREBASE_STORAGE_BUCKET`.

**Common optional env:** `TLM_GRADE` / `TLM_SUBJECT` (pre-select a pair at startup) · `TLM_WORKSPACE` · `TLM_BUCKET_PREFIX` (namespace everything under a prefix) · `TLM_ASSETS_DIR` · `TLM_DOMAIN_NEIGHBORHOOD_K`. Full list and semantics: [technical reference → Configuration](docs/technical-reference/).

## Firestore KG store + curator loop

The knowledge graph lives in a generic Firestore node/edge store with a **double-buffered draft/published** model and a curator/approver **edit → review → publish** loop (generic graph verbs `add_node`/`move_node`/`edit_node` and batched `add_nodes`/`create_edges`, all two-phase-confirmed and audited). Import a graph, and export it for backup/interchange:

```bash
npm run import:kg-store -- <workspace> <grade> <subject> knowledge_graph.json   # add a namespace
npm run export:kg-store -- <workspace> <grade> <subject> out.json               # dump it back out
```

Full lifecycle, roles, verbs, integrity rules, and audit: [technical reference → KG node/edge store](docs/technical-reference/store.md).

## The generation flow (in brief)

1. `set_context(workspace, grade, subject)` — pick what you're working on.
2. Walk the curriculum for what you're generating — `walk_document` for a whole document, `walk_document_section` for a single piece (the section that covers it) — each returns the subtree plus the routines + formatters that apply, and `get_terminology` (and, for CI maths, `suggest_fresh_domain`) supplies the glossary and a fresh example-domain suggestion.
3. Generate the `.docx`.
4. `create_upload_url(relPath)` → `PUT` the file to the signed URL (no large payloads through MCP).
5. `log_generation(nodeId, relPath, content)` — records what you produced against the **scope node** the document covers (md5 read from storage).

The outward-writing tools (`create_upload_url`, `log_generation`, `record_document_content`) are gated by a confirmation step. Details, preview generation, ingestion, and reconciliation: [technical reference](docs/technical-reference/generation-and-storage.md#the-generation-flow-cross-host-no-shared-disk).

## Tools

The live surface is mirrored by `get_capabilities`; this is the map.

- **Context:** `set_context`, `get_context`, `get_capabilities`.
- **Graph reads (generic):** `walk_graph` (directional, filtered, paginated BFS — the traversal primitive), `namespace_stats` (orientation snapshot), `get_standards`.
- **Generation reads:** `walk_document`, `walk_document_section` (a whole document, or the single section that covers a piece — the per-piece reader — each with the routines + formatters that apply), `get_terminology`, `terminology_sections`.
- **Curator loop — authoring (role-gated):** `add_nodes`, `create_edges`, `edit_node`, `move_node`, `delete_nodes`, `delete_edges` (single-node `add_node` underlies `add_nodes`).
- **Curator loop — lifecycle (role-gated):** `diff_draft`, `review_draft`, `publish_draft`, `discard_draft`, `read_audit`.
- **Subject profile & guide:** `get_profile`, `edit_profile`, `get_graph_guide`.
- **Catalog, routines & formatters:** `list_catalog`, `get_catalog_entry`, `add_to_catalog`, `use_routine`, `use_formatter`.
- **Documents & generation output:** `list_documents`, `create_upload_url`, `create_download_url`, `get_document_text`, `record_document_content`, `log_generation`, `reconcile`, `preview_generation`, `create_preview_upload_url`.
- **Workspaces (tenant admin):** `list_workspaces`, `create_workspace`, `add_member`, `remove_member`, `list_members`.
- **CI maths only:** `suggest_fresh_domain`, `domain_usage`.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — architecture summary, module layering, conventions (the working guide).
- [`docs/technical-reference/`](docs/technical-reference/) — the full operational manual: KG store & curator loop, integrity/audit, the read-only KG explorer, buckets, generation/preview flow, deployment & hosting.
- [`DEPLOY.md`](DEPLOY.md) — production deployment runbook.
- Design notes ([`docs/design-notes/`](docs/design-notes/) — the *why* behind each subsystem): [multi-subject architecture](docs/design-notes/multi-subject-architecture.md) · [KG mutations framework](docs/design-notes/kg-mutations/) · [preview generation](docs/design-notes/preview-generation-findings.md) · [KG explorer findings](docs/design-notes/kg-explorer-findings.md) · [read-audit findings](docs/design-notes/read-audit-findings.md).
