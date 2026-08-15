## Architecture

The architecture summary lives in [CLAUDE.md](../../CLAUDE.md) — the converged `{ nodes, relationships }` envelope + LC metadata scheme, the one-adapter-per-subject model (`detect`/`parse` + the LC→friendly projection + `buildGenerationContext`, behavior only — no schema on the adapter), and the enforced module layering (imports point **down**; service modules never import `adapters`; the generic `CurriculumModel ⇄ nodes/edges` round-trip lives in `curriculum/store-bridge.ts`). The full design rationale is in [`docs/design-notes/multi-subject-architecture.md`](../design-notes/multi-subject-architecture.md). The operational how-to for wiring a new subject follows.

## Adding a new grade/subject

Adding a subject takes its **sources** (data) and an **adapter** (code). If the knowledge-graph shape matches one that's already registered, you can point a new `(grade, subject)` key at that adapter's builder — the registry is many-to-one on purpose.

1. **Drop in the sources** under `sources/<grade>/<subject>/`: `knowledge_graph.json`, `terminology.json`, the generation prompt(s), and optionally `example_domains.json`.

2. **Reuse or write an adapter** (`src/adapters/`):
   - *Same graph shape as an existing subject* → register the new `(grade, subject)` key against that subject's builder in `src/adapters/index.ts`. That's the many-to-one case.
   - *Different shape* → add `src/adapters/<subject>.ts` exporting a `buildXxxAdapter(grade, subject): SubjectAdapter`. The adapter carries everything: raw-envelope `detect`/`parse`, the LC→friendly projection (`listUnits`/`slice`/`progression`/`requiredCoverage`/`scopeValues`), the `deliverables` list (`key`, `label`, `scopeKind`, `classify(filename)`, `dependsOn`, `promptFile` — one per document kind), the `capabilities` flags (`exampleDomainRotation`), and `buildGenerationContext(scope, deliverableKey)`. Optional CI maths-style helpers (`suggestFreshDomain`, `domainUsage`) are only added when the subject enables the matching capability.

3. **Register it** in `src/adapters/index.ts` under the `"<grade>/<subject>"` key (in the `REGISTRY` object). Grade × subject: e.g. `"ci/maths"` and `"cp/maths"` may point at the same builder or different ones — that's a per-pair choice, not an assumption.

4. **Build and select it:** `npm run build`, then `set_context("<grade>", "<subject>")`. The guard runs your adapter's `detect()` against the KG; on a mismatch it refuses to activate and says why — nothing is silently mis-parsed.

**No schema.** Adapters carry behavior only. If your subject needs write-safety rules (uniqueness, required properties, edge-type constraints), those will live in the write tools when they land — not on the adapter. The stored `id` for every node/edge is the raw LC IRI, verbatim; friendly properties (`chapitreNum`, `semaine`, `statementCode`) live inside `properties.raw` and must NOT be used as write-target identities.

**Rules the build enforces:** imports point *down* the layers above; **service modules (`storage`/`curriculum`/`generation`/`kg-store`) must not import `adapters`** — pass what they need in as arguments (as `reconcile(deliverables)` and `discoverDocuments(deliverables)` do); cross-module imports go through the module's `index.ts`. `npm run check:cycles` fails the build on any import cycle.

> **CE1 reading** is wired as a worked second subject (scope: one teacher guide **per week**), registered as `ce1/reading` — its adapter parses a `nodes`/`relationships` + `hasChild` graph. See `docs/design-notes/multi-subject-architecture.md` §11 phase 4 for what its KG needed and the open follow-ups (no `terminology.json` yet; evaluation grids pending).

## Testing note

The storage layer sits behind a small `StorageAdapter` interface. The reconcile / history / variety / ingest logic is verified against an in-memory fake (no credentials needed). Unit tests run with `npm test` (Vitest); the example-domain neighborhood/suggestion logic is covered in `src/generation/__tests__/domains.test.ts`. `npm run build` runs the import-cycle check (`npm run check:cycles`) before `tsc`, so a broken layer boundary fails the build. The **Firebase implementation is compile-checked but not live-tested here** — validating real bucket calls (list, signed URL, download, history read/write) needs your service-account credentials and network access, so do a first run against your own project.

## Assumptions still baked in (tell me to change any)

- One grade/subject is active at a time; switching drops the KG, terminology, and history caches so the next call reloads for the new context.
- Deliverable classification is per-subject (a profile's `DeliverableSpec.classify`). For CI maths: within a chapter subfolder, anything not "Fiches de leçons …" is the pupil manual.
- Glossary derives from the KG, with the FR/Wolof file as fallback; characters are derived from what you log/ingest.
- "Latest" among duplicates is the object whose md5 matches history, else the most recently updated.
