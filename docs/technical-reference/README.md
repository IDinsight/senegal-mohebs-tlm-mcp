# Technical reference — senegal-mohebs-tlm-server

The deep operational + design reference, split by concern (one file per topic). The
[README](../../README.md) is the short overview; [CLAUDE.md](../../CLAUDE.md) is the
current architecture summary; [DEPLOY.md](../../DEPLOY.md) is the production runbook.

> **Repo layout.** The server is a self-contained package under **`backend/`** (`backend/src`,
> `backend/scripts`, `backend/test`, `backend/assets`, its own `package.json`/`Dockerfile`); the
> explorer UI is its own package under `frontend/`. Run `npm` commands from `backend/`, and read
> the bare `src/…`, `scripts/…`, `test/…`, `assets/…` paths throughout these notes as relative to it.

> **Note (maths↔reading convergence).** Both subjects now share the `{ nodes, relationships }` envelope + LC metadata scheme and parse through one generic `curriculum/parse-graph.ts`. Chapter↔lesson membership is the `hasChild` **edge** — the old denormalized `chapitreNum` join is gone, so move/split rewire the edge and renumber changes only the chapter's own number (no cascade, no drift). The sections below have been updated where it matters, but if any deeper design prose still says "chapitreNum join" / "regime-B", read it as historical — CLAUDE.md is the current source of truth.

## Contents

- [`store.md`](store.md) — the KG node/edge store + the curator loop: seed/cutover,
  draft/published, the two-phase mutation framework, write-safety, integrity, audit,
  roles, structural verbs, recipes, `get_capabilities`, `read_audit`, import/export.
- [`explorer.md`](explorer.md) — the read-only live KG explorer: endpoint contract,
  the raw-LC→display transform, data-driven views, deploy.
- [`generation-and-storage.md`](generation-and-storage.md) — bucket layout, the
  cross-host generation flow, preview generation, ingesting an externally-authored
  doc, reconciliation.
- [`deployment.md`](deployment.md) — production deployment, remote (HTTP) mode +
  per-request actor identity, wiring into a host.
- [`architecture-and-extending.md`](architecture-and-extending.md) — architecture,
  adding a new grade/subject, testing, baked-in assumptions.
