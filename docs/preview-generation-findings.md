# Preview generation (draft-resolved) — findings & decisions

Phase 3, step 1. Let an expert who has staged a draft edit generate a **preview**
of the teaching material that edit would produce — reading the **draft** instead
of published — without touching published, the canonical documents bucket, or the
canonical generation history. Closes the loop: the dry-run / `diff_draft` shows the
graph **diff**; preview shows the resulting **material**.

## Generation architecture & where "read from draft" plugs in

The real flow, today, resolves everything from **published**:

1. `set_context` → `activate.ts` reads the **published slot**, `deserializeToModel`
   (`curriculum/store-bridge.ts`, the #3 path), and pins the `CurriculumModel` in
   the session bag under `PRELOADED_MODEL_KEY`.
2. `get_generation_context(unit, deliverable)` → `adapter.buildGenerationContext`.
   Every curriculum read inside it (`slice`/`progression`/`requiredCoverage`/
   `listUnits`) resolves through the adapter's `ensure()` → **that preloaded
   published model**. Characters/coverage come from document history; example
   domains from the domain pool.
3. Claude (LLM) produces the `.docx` from context + `get_prompt`.
4. `create_upload_url` → canonical `documents/` bucket (confirmation-gated);
   `log_generation` → canonical `history.json`.

The single resolution point is `PRELOADED_MODEL_KEY` (published). `diff_draft`
already reads the **draft slot** (`pointer.draftSlot` → `listNodes`/`listEdges`)
and deserializes it. So "read from draft" = resolve a draft `CurriculumModel` from
that same slot and feed it to the *same* `buildGenerationContext`.

**Decision — tool surface: a dedicated `preview_generation` tool** (confirmed with
the requester, diverging from the task's stated `useDraft`-flag default). Rationale:
`get_generation_context` / `create_upload_url` / `log_generation` stay
**byte-identical** for existing callers (parity by construction), and preview
becomes an *observably* separate, non-canonical surface — the isolation boundary
is legible rather than a flag on the canonical tool that a caller could pair with
the canonical `log_generation`.

**Reuse, not a parallel resolution path.** `buildGenerationContext` gained an
optional third param `model?: CurriculumModel`. When provided (preview passes a
draft-resolved model), the adapter builds from it; when omitted, it resolves the
published model via `ensure()` exactly as before. The projection helpers in both
adapters (`adapters/maths.ts`, `adapters/reading.ts`) were refactored to take the
model as an **argument** (not a shared/mutable override) so a preview read is
fully isolated from any concurrent published read in the same session.

The draft model is resolved in `server/preview.ts::resolveDraftModel` — pointer →
draft slot → `listNodes`/`listEdges` → `deserializeToModel`, the same slot + bridge
`diff_draft` uses. (Firestore mode only; bundle mode has no draft concept and
returns "no draft".)

## Preview-output handling (the isolation crux)

**Decision — segregated + short-lived + labelled** (confirmed).

- `create_preview_upload_url(relPath)` signs a **write + read** URL pair for a
  throwaway `.docx` under a **sibling `previews/` prefix** (`context/state.ts::
  previewKey`), never the canonical `documents/` keyspace.
- **10-minute** TTL (shorter than the 15-minute canonical URLs).
- Both URLs carry the fixed label *"PREVIEW — generated from an unpublished draft,
  not a published deliverable."*
- **Never** `create_upload_url` → `documents/`, **never** `log_generation`, **never**
  `list_documents` / `reconcile` (those scan only `documents/`, so a `previews/`
  object is structurally invisible to the tracked history).
- No confirmation gate: it is not a canonical write, it auto-expires, and it is part
  of the read-like preview flow.

## No-draft behavior

**Decision — clear notice, no output.** `preview_generation` with no draft returns
`{ preview: true, noDraft: true, message }`. Silently previewing published is
rejected as misleading.

## Role

**Decision — curator + approver; unknown/no-role blocked + audited.** Same
`authorize(readDraft)` tier as `diff_draft` (a draft is pre-publish WIP). Both
preview tools share the gate. Read-like → no two-phase confirm, no token.

## Audit

**Decision — a distinct `preview` event on success, plus `blocked` on denial.**
`AuditEventType` gained `"preview"`. A successful preview appends one `preview`
record (who read unpublished draft content, for which unit/deliverable) — it never
masquerades as an `apply`/`publish`/real-generation record and is never written via
`log_generation`. Denials append the usual `blocked` record (same shape as every
other denial in the codebase).

## Scope / cost

**Decision — always one unit + one deliverable.** The tool schema requires both;
there is no implicit whole-curriculum path. The unknown-deliverable check runs
before any draft read.

## Comparison (draft vs published)

**Decision — deferred.** Previewing draft AND published for the same scope so the
expert sees exactly what changes in the *output* is the highest-value version but
doubles LLM cost, and the graph-level change is already available via `diff_draft`.
Draft-only preview ships now; the comparison is a follow-on.

## Files touched

- `types.ts` — `buildGenerationContext(…, model?)`; optional `StorageAdapter.createPreviewUpload`.
- `adapters/maths.ts`, `adapters/reading.ts` — model threaded through projections.
- `context/state.ts` — `previewsPrefix` / `previewKey`.
- `storage/firebase.ts` — `createPreviewUpload` (10-min write+read URLs under `previews/`).
- `kg-store/types.ts` — `preview` audit event type.
- `server/preview.ts` — `preview_generation` + `create_preview_upload_url` (+ testable cores).
- `server/index.ts` — register the preview tools.
- `server/capabilities.ts` — `canPreview` action + `preview` block.
- `server/preview.test.ts` — draft-reflects-edit, no-draft, isolation, segregation, role matrix, scoping, parity.
