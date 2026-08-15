## Bucket layout

```
gs://<FIREBASE_STORAGE_BUCKET>/
  _state/<user-id>.json        # per-user active grade/subject (HTTP mode)
  <grade>/<subject>/
    documents/
      chapitre_05/<Manuel …>.docx
      chapitre_05/<Fiches de leçons …>.docx
    previews/                    # throwaway preview .docx (draft-resolved); NOT canonical
      chapitre_05/<Manuel …>.docx
    history.json
```
`previews/` is a **sibling** of `documents/`, never inside it — reconciliation only scans `documents/`, so a preview object can never enter the tracked history (see *Preview generation* below).
Document identity is the **graph node the document covers** — its *scope node* (a `Chapitre`/`Semaine`/`Lesson`), keyed by that node's id **within a grade/subject** (see [`../design-notes/graph-linked-documents.md`](../design-notes/graph-linked-documents.md)). The filename is **no longer parsed for identity**: `relPath` stays a human-readable location, and a doc is linked to its node at record time. The which-Course-which-node split *is* the old manual-vs-lessons split (a chapter's pupil manual covers its `Chapitre` under the Student's Book; its lesson sheets cover the chapter's `Lesson`/week node under the Teacher's Guide).

## The generation flow (cross-host, no shared disk)

0. `set_context(grade, subject)` — pick what you're working on. `get_context` lists the installed pairs and the current selection.
1. Read the curriculum **from the graph** for the node you're generating: `get_graph_guide` for the subject's conventions, then `walk_graph` / `get_standards` from the scope node down (its routine and formatter come with it via `usesRoutine`). There is no per-deliverable prompt tool — generation guidance is assembled from the guide + the node's attached routine/formatter + the graph. (CI maths storybook variety still has `suggest_fresh_domain` / `domain_usage` for a fresh object family per chapter.)
2. Generate the `.docx`.
3. `create_upload_url(relPath, confirm)` → the server returns a short-lived **signed URL**. Upload the file with an HTTP `PUT` (Content-Type `application/vnd.openxmlformats-officedocument.wordprocessingml.document`). No large payloads go through the MCP channel. **Requires confirmation** — see below.
4. `log_generation(nodeId, relPath, content, confirm)` — the server checks `nodeId` names a real scope node in the active graph, reads the uploaded object's md5 from storage, and records what you produced against that node. History updated; no local file needed. **Requires confirmation** — see below.

> **Confirmation gate.** The three tools that write outward — `create_upload_url` (gates the upload), `log_generation`, and `record_document_content` — never act without approval, using the strongest gate the client supports:
> - **Client supports MCP elicitation** → the server asks the **user** directly via an elicitation dialog. This is a hard gate: the agent cannot bypass it (even passing `confirm: true` won't skip it — a declined dialog blocks the action).
> - **Otherwise** → an agent-mediated two-step: the first call performs no side effect and returns the shared confirmation envelope `{ needsConfirmation: true, action, message }` (`action` states the stakes; `message` tells the agent to re-call with `confirm: true`); the agent asks the user, then re-calls with `confirm: true`.
>
> Input validation (e.g. a `nodeId` that names no node in the active graph) runs before the gate, so bad calls fail first. All read-only tools are ungated. Note: in a fully headless run (no user, no elicitation) these tools cannot get approval by design — drive them only where a human is reachable.
>
> **Two lifecycles share only the envelope shape.** Document tools write **live** to the bucket / history — the confirm is the ONLY gate, and the `action` field says "writes NOW … no draft, no undo". Graph mutations (see below) **stage a draft edit** — the same envelope, but the `action` says "STAGES a draft edit … nothing reaches generation until you separately publish". Uniform mechanics; deliberately different stakes.

## Preview generation (draft-resolved, isolated from published)

An expert who has staged a draft edit can generate a **preview** of the teaching material that edit would produce — reading the **draft** instead of published — **without touching published, the canonical documents bucket, or the canonical generation history.** This closes the editing loop: the dry-run (per-mutation diff) and `diff_draft` show the **graph change**; preview shows the **result** — the material that change yields.

- **`preview_generation(course)`** — the draft-resolved read. It resolves the curriculum from the **draft slot** (the same slot `diff_draft` reads) via the store-bridge and the subject adapter, then returns the containment subtree under that `course` — the same shape `walk_graph` exposes on published, but from the draft model. The result is **tagged `preview`** and carries the label *"PREVIEW — generated from an unpublished draft, not a published deliverable."* Read-only on the draft — it does **not** mutate the graph.
- **`create_preview_upload_url(relPath)`** — the preview **output** path. Signs short-lived (10 min) write + read URLs for a throwaway `.docx` under the **segregated `previews/` prefix**. Never the canonical `documents/` bucket, never `log_generation`, never `list_documents`/`reconcile`. `PUT` the generated file to `uploadUrl`, hand the human `downloadUrl`.

**Isolation guarantees** (all covered by `src/server/__tests__/preview.test.ts`):
- A preview reflects a staged-but-unpublished edit, while published generation still reflects the old wording.
- After a preview run, the published slot, the pointer, the canonical bucket, `history.json`, and `log_generation` records are **byte-for-byte unaffected**; the only audit added is a distinct **`preview`** event (never an `apply`/`publish`/real-generation record).
- Preview output lives under `previews/` — structurally invisible to the tracked document history.

**No draft?** `preview_generation` returns a clear *"no draft to preview"* notice (and no output) rather than silently previewing published — which would be misleading.

**Who?** Same trust tier as `diff_draft`: **curators and approvers** may preview; unknown / no-role callers are blocked (and the denial is audited). It is read-like, so there is no two-phase confirm and no token.

**Scope.** A preview always targets **one Course** — there is no implicit whole-workspace preview (generation is LLM-driven and costly).

**Deferred.** A draft-vs-published output *comparison* (previewing both for the same scope so the expert sees exactly what changes in the material) is a follow-on — it doubles LLM cost, and the graph-level change is already available via `diff_draft`.

`get_capabilities` advertises this under a `preview` block, so an agent can offer "want to see what this generates before publishing?".

## Ingesting a doc authored elsewhere (e.g. an expert wrote chapter 2)

1. The file is in the bucket (uploaded any way you like), under the grade/subject's `documents/`.
2. `reconcile` surfaces it as untracked (by `relPath` — it no longer classifies filenames).
3. `get_document_text(relPath)` returns its plain text (server downloads from the bucket and extracts via mammoth — it never calls an LLM).
4. Extract the structured content and call `record_document_content(nodeId, relPath, content, confirm)` to **link** the doc to the scope node it covers (**requires confirmation** — call with `confirm: true` after the user approves). Tracked from then on.

## Reconciliation

Run on startup (when a context is active) and via the `reconcile` tool. It is **discover-only** — it lists the bucket's `.docx` objects and diffs them against history **by `relPath`**, with no filename classification: present + md5 matches history → **tracked**; `relPath` in no entry → **untracked (new)**; `relPath` known but md5 differs → **untracked (changed)**; in history but the object is gone from the bucket → **dropped** (the stale entry is removed). The curator/LLM links each untracked doc to its node via `record_document_content`. (A pre-node-keyed `history.json` — the old `(unit, deliverable)` schema — is ignored on load, so its docs re-surface as untracked for a one-time re-link; the bucket objects are untouched.)
