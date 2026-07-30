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

> **Note.** Dropping in a folder provides the *data* for a grade/subject. Wiring it up so the tools actually work also needs a registered **adapter** — one behavior module per subject that owns everything from raw-graph parsing to generation-context assembly. A folder with no registered adapter is rejected by `set_context`. See [Adding a new grade/subject](#adding-a-new-gradesubject).

## Configuration

Required:
- `SERVICE_ACCOUNT_KEY_PATH` — path to your Firebase service-account JSON (used for auth **and** for signing upload URLs).
- `FIREBASE_STORAGE_BUCKET` — the bucket name, e.g. `your-project.appspot.com`.

Optional:
- `TLM_GRADE` / `TLM_SUBJECT` — pre-select the active grade/subject at startup, so you don't have to call `set_context` first. Must match an installed folder pair.
- `TLM_BUCKET_PREFIX` — put everything under a prefix (e.g. `pilot` → `pilot/ci/maths/documents/…`, `pilot/ci/maths/history.json`). The grade/subject scope is always appended after the prefix.
- `TLM_SOURCES_DIR` — relocate the sources root (defaults to `./sources`). The per-subject filenames inside each `<grade>/<subject>` folder are fixed conventions: `knowledge_graph.json`, `terminology.json`, optional `example_domains.json`, and the prompt `.md` files (each subject's adapter names its own prompt files via `DeliverableSpec.promptFile`).
- `TLM_DOMAIN_NEIGHBORHOOD_K` — how many chapters on each side count as a chapter's "neighborhood" for example-domain variety (default `3`). `get_generation_context` only reports the domains used by chapters within ±K of the target (by chapter number), and its fresh-domain suggestion avoids anything in that window. Larger K = stronger variety across a wider span; the payload stays bounded by the window regardless of how many chapters are authored.
- `KG_SOURCE` — where curriculum + KG reads pull from: `bundle` (default; legacy `readFileSync(sources/…)`) or `firestore` (hydrate from the seeded node/edge store). Reversible without a rebuild. See [KG node/edge store](#kg-nodeedge-store) below.

## KG node/edge store

Curriculum + KG data can live in a generic node/edge store on Firestore, so
later steps can expose editing tools without rewiring the read layer. Two
collections, each namespaced by `${TLM_BUCKET_PREFIX}<grade>/<subject>` (the
same key the docs bucket and history use):

- `kg_nodes` — one document per curriculum unit: `{ id, type, namespace, properties }`. `type` is the adapter-produced kind (maths: `chapter, lesson, component, task`; reading: `week, standard, component`). `properties` carries the normalized fields (`code, title, text, order, isAssessment`) plus the raw graph passthrough under `raw`. Ids are the verbatim UUIDs from the bundled KGs — never regenerated.
- `kg_edges` — one document per adapter-produced link: `{ id, type, from, to, namespace, properties }`. `type` is either `hasChild` (parent→child hierarchy) or `buildsTowards` (maths cross-chapter progression). `properties` records `orderInParent` / `sequenceInFrom` / `sequenceInTo` so child and progression ordering round-trip byte-identically.
- `kg_meta` — one doc per namespace holding the seed provenance stamp: `{ contentHash, seededAt, adapterId, nodeCount, edgeCount }`. The seed writes it last, so its presence is the signal that the namespace was successfully seeded; `activateContext` refuses to load an unseeded namespace when `KG_SOURCE=firestore`.

The store is still **read-only from the outside in this phase** — no MCP write tools, no user-facing lifecycle tools, no permissioning. But it now has a **draft/published split** under the hood so later steps have somewhere to write. See [Draft/published state](#draftpublished-state) below.

### Seed

```bash
npm run seed:kg-store                    # seed every installed grade/subject
npm run seed:kg-store -- ci maths        # seed a single pair
npm run seed:kg-store -- --dry-run       # in-memory store; no writes
```

Idempotent: a re-run converges to the same state (no duplicates, no stragglers). Needs the same Firebase credentials the server uses (`SERVICE_ACCOUNT_KEY_PATH` or `SERVICE_ACCOUNT_KEY_JSON`, and `FIREBASE_STORAGE_BUCKET`).

### Cutover

```bash
KG_SOURCE=firestore npm run start:http   # or npm start for stdio
```

`KG_SOURCE=bundle` (the default) keeps the server behaving exactly as before — the bundle loader stays in place, so the flag is a clean toggle in either direction. The per-call actor log line records the active `kgSource`, so the audit stream shows which data path served each tool call.

### Draft/published state

Each namespace (firestore backend only — bundle mode is unchanged) holds up to **two slots** of curriculum data, `a` and `b`, plus one small **pointer doc** (`kg_pointers/<nsSlug>`) that says which slot is currently `publishedSlot` and which (optionally) is the in-progress `draftSlot`. Reads follow the pointer: `activate.ts` resolves `publishedSlot` first and hydrates the `CurriculumModel` from that slot. **Generation always reads published**, so an in-progress draft can never leak into produced materials.

- **create draft** copies published → the free slot, then sets `draftSlot` in the pointer LAST. A half-copied draft is invisible to readers. Idempotent: calling it when a draft already exists is a no-op.
- **publish draft** is a single-doc pointer flip (`publishedSlot := draftSlot; draftSlot := null`). Firestore's single-doc write guarantee makes it atomic — readers see either the pre-publish snapshot or the post-publish snapshot, never a mix.
- **discard draft** clears `draftSlot`. Orphaned draft docs remain in the free slot and get overwritten wholesale by the next `create draft`.

Node and edge ids are the LC UUIDs verbatim (nodes) and deterministic `edgeId(type, from, to)` values (edges). Both survive create/publish byte-for-byte, so later diff-by-id and cross-version references remain sound.

These lifecycle functions live on the internal `KgNodeStore` interface — **no user-facing MCP tools are exposed yet**. Tool-facing wrappers for `create_draft` / `publish_draft` / `discard_draft` (and a `diff_draft`) land in a later step (#10). Preview generation against a draft (#15) will use the draft-read path that this step lays down but doesn't expose.

### Graph-mutation framework (draft-only apply)

Sits on top of the draft/published split. A **graph mutation** is a pure function over `{nodes, edges}` — e.g. "set property X on node Y", "delete node Z". The framework in [`src/kg-store/mutations.ts`](src/kg-store/mutations.ts) gives every new mutation the same two-phase confirm plumbing for free:

- **preview** (no `confirm`) → runs `validate` (empty seam today; #6 fills it), computes a per-mutation `diff` keyed by stable id, and returns the shared confirmation envelope extended with `diff`, `warnings`, and a `confirmationToken`. Changes NO state.
- **confirm** (with the `confirmationToken`) → verifies the token matches the mutation + args + base-version + is unused, lazily creates a draft if none exists (byte-for-byte from published), then applies the mutation to the **draft slot only** via `writeSlot`. Published is unaffected — publish is a separate step (#10).

The framework uses only stable ids (LC IRIs for nodes; deterministic `edgeId(type, from, to)` for edges) — friendly properties like `chapitreNum` live in `properties.raw` and are NEVER used as identity. A stale token (base moved between preview and confirm) or a replayed token is rejected cleanly with no partial apply. See [`docs/kg-mutations-framework.md`](docs/kg-mutations-framework.md) for the full design note, decisions, and the mutation interface.

**No user-facing graph edit tool ships in this step.** The framework has exactly one test-only mutation, wired inside `mutations.test.ts` — real edit tools (`upsert_property` / `create_node` / `delete_node` / `link_nodes`) land in #11/#12.

### Write-safety rules (structural only)

Every graph mutation goes through two shared structural rules in [`src/kg-store/validate.ts`](src/kg-store/validate.ts) before the human review gate. Errors from either rule **block confirmation** — no token is issued, so there's nothing to replay.

- **Rule 1 (id-immutable).** A node's id is the LC IRI verbatim; an edge's id is `edgeId(type, from, to)`. Every reference in the graph points at these ids, so a silent rename would orphan everything the reviewer can't easily see in a diff. The rule detects a rename by looking for a removed node/edge and an added node/edge that share the same content — that pair is treated as a rename attempt and rejected. Legitimate delete-then-create (genuinely different content) passes.
- **Rule 2 (no-orphan).** After the edit, every edge's `from` and `to` must resolve to a node in the graph. This subsumes "no removed node has surviving edges targeting it." Rule 2 is built and tested now but only becomes load-bearing when #12 introduces delete/relink mutations — today, no mutation removes nodes or edges, so it's trivially satisfied.

**Denylist = just the `id` key** (on nodes and edges). References in this graph are edges-only at the storage level — `properties.raw` carries content and match-keys, never a stored id pointing at another node — so there are no reference-bearing properties to protect. If a future subject introduces one, the denylist extends by a single entry.

**We don't check content.** Whether a title reads well, whether a number is sensible, whether wording matches the KG's own — that's what the draft → review → publish gate is for. A reviewer sees the whole diff and approves it. The machine only guards the two errors a reviewer can't eyeball; anything else would drift toward the schema we deliberately don't build.

A mutation may still add its own `validate(base, after, args)` on top of the shared rules for anything only it can decide; both layers run and their errors compose.

### Audit log (append-only, atomic with the change)

Every state-changing graph operation writes a record to a single append-only Firestore collection `kg_audit`. Query surface: `KgNodeStore.listAudit(filter)` filters by namespace, actor id, event type, and time range (newest first). No update/delete method exists on the interface, and the write path uses `set` on a fresh doc id only — never `update()`, never `delete()`. A future Firestore security rule can lock this in externally.

Events:
- **`apply`** — a graph mutation was applied to the draft. Carries the #5 diff inline, plus `baseVersion` / `resultingVersion` (sha256 of the sorted-canonical graph before/after).
- **`createDraft`** — a draft was created from published (byte-for-byte copy).
- **`publish`** — the draft was promoted to published. References `promotedApplyIds`; no whole-draft diff (that's #10).
- **`discard`** — the draft was thrown away. References `discardedApplyIds`.
- **`blocked`** — a mutation was rejected (structural rule failure, custom validate error, or a confirm-time token mismatch: stale / replay / argsMismatch / mutationMismatch / invalidToken / unseeded). Lightweight: `{ actor, ts, namespace, mutation, reason }`, no diff, no versions. Distinguishable from committed changes by `eventType`.

**Atomicity.** Each committed-change record is written in the SAME Firestore transaction as its state write:
- `publishDraft` / `discardDraft` — single-doc pointer transaction; the audit doc joins that same tx.
- `createDraft` — the final `draftSlot` flip is a pointer transaction; the audit doc joins it. Byte-for-byte copy happens beforehand and is not itself transactional (pre-existing #4 limitation).
- `writeSlot` (apply) — bulk node/edge writes are chunked (Firestore's 500-op transaction cap forbids one big tx); the FINAL step is a transaction on the pointer meta doc, and the apply audit joins that tx. If a crash lands inside the bulk-write window, the draft may be inconsistent AND no audit is recorded — the same partial-write window #4 already had. Reliability of the audit equals reliability of the state write; the log never carries a phantom record for a state change that didn't happen.

**Who.** The actor is captured verbatim from #1 — including `actor.unknown` when no verified identity is available. The audit records who *tried*; it does **not** restrict anyone. Until roles land (#8), unattributed writes remain possible (locally, via `ALLOW_UNAUTHENTICATED=1`); the audit log will surface them faithfully as `actor.id === "unknown"`.

**What is NOT audited here.** The document tools (`create_upload_url`, `log_generation`, `record_document_content`) write live to the bucket / history and are a separate lifecycle. #7 deliberately does not audit them; a follow-on could extend the same append-only log to those events if desired. The seed script does not emit audits either — it's an operator step, not a runtime graph operation.

**Traceability.** Each request already emits one structured log line via #1. Once #11 ships a real graph edit tool, the tool's response will include the resulting `auditId`s and the log line will mirror them for one-line tracing. Until then, records are independently queryable by actor + namespace + time.

**Concurrency of edits is an open decision for the next step.** With no write tools this step doesn't exercise contention. When writes land (#5/#11), the team will need to pick a strategy — optimistic version counter on each edit, an explicit "who holds the draft" lock, or per-user drafts. The two-slot foundation supports any of them; nothing about it locks in the choice.

**Re-seeding after a publish.** The seed always writes into slot `a` and only initialises the pointer the first time (`ensurePointer` is a no-op if one already exists). Once a curator publishes (which flips `publishedSlot` to `b`), a re-seed writes to `a` — which is now a stale side copy, not the live published data. The seed logs a WARNING when it detects this; reconciling it deliberately (typically by making the fresh bundle the next draft rather than the next seed) is the operator's call.

### Parity check

`get_generation_context`, `get_curriculum`, and `list_units` must return structurally identical output for every grade/subject and every unit against both backends. Run:

```bash
npm run parity:kg-store                  # offline: memory store seeded from bundle
npm run parity:kg-store -- --live        # against live Firestore (needs a prior seed)
npm test                                 # includes src/kg-store/parity.test.ts
```

Diffs fail the harness. The oracle deep-equals the parsed reads — key ordering doesn't cause false diffs, but the response shape itself must not change. A secondary manual check (regenerating a manual and a lessons deliverable with the flag flipped and confirming the pre-LLM generation context is identical) is documented in the roadmap; the LLM output itself is not byte-stable and is not the parity oracle.

## Bucket layout

```
gs://<FIREBASE_STORAGE_BUCKET>/
  _state/<user-id>.json        # per-user active grade/subject (HTTP mode)
  <grade>/<subject>/
    documents/
      chapitre_05/<Manuel …>.docx
      chapitre_05/<Fiches de leçons …>.docx
    history.json
```
Document identity is `scope:deliverable` (e.g. `5:manual`, `5:lessons`) **within a grade/subject**; the scope is the first integer in the subfolder name, and the active subject's adapter classifies the filename into a deliverable (for maths: a file named "Fiches de leçons …" is the lesson-sheets doc, anything else is the manual).

## The generation flow (cross-host, no shared disk)

0. `set_context(grade, subject)` — pick what you're working on. `get_context` lists the installed pairs and the current selection.
1. `get_generation_context(unit, deliverable)` — curriculum slice, established characters, terminology guidance, coverage, and (for the teacher guide) the manual to build on. `unit` is the scope value (for maths, the chapter number) and `deliverable` is a deliverable key (`manual`/`lessons`). For example-domain variety it returns `exampleDomains: { suggested, avoidNearby }`: `suggested` is a fresh object family to use, and `avoidNearby` maps each *nearby* chapter number (within ±`TLM_DOMAIN_NEIGHBORHOOD_K`) to the domains it used — so adjacent chapters don't repeat the same family. This is a bounded window, not the whole book; use `domain_usage` for the full log.
2. Generate the `.docx`.
3. `create_upload_url(relPath, confirm)` → the server returns a short-lived **signed URL**. Upload the file with an HTTP `PUT` (Content-Type `application/vnd.openxmlformats-officedocument.wordprocessingml.document`). No large payloads go through the MCP channel. **Requires confirmation** — see below.
4. `log_generation(unit, deliverable, relPath, content, confirm)` — the server reads the uploaded object's md5 from storage and records what you produced. History updated; no local file needed. **Requires confirmation** — see below.

> **Confirmation gate.** The three tools that write outward — `create_upload_url` (gates the upload), `log_generation`, and `record_document_content` — never act without approval, using the strongest gate the client supports:
> - **Client supports MCP elicitation** → the server asks the **user** directly via an elicitation dialog. This is a hard gate: the agent cannot bypass it (even passing `confirm: true` won't skip it — a declined dialog blocks the action).
> - **Otherwise** → an agent-mediated two-step: the first call performs no side effect and returns the shared confirmation envelope `{ needsConfirmation: true, action, message }` (`action` states the stakes; `message` tells the agent to re-call with `confirm: true`); the agent asks the user, then re-calls with `confirm: true`.
>
> Input validation (e.g. unknown deliverable) runs before the gate, so bad calls fail first. All read-only tools are ungated. Note: in a fully headless run (no user, no elicitation) these tools cannot get approval by design — drive them only where a human is reachable.
>
> **Two lifecycles share only the envelope shape.** Document tools write **live** to the bucket / history — the confirm is the ONLY gate, and the `action` field says "writes NOW … no draft, no undo". Graph mutations (see below) **stage a draft edit** — the same envelope, but the `action` says "STAGES a draft edit … nothing reaches generation until you separately publish". Uniform mechanics; deliberately different stakes.

## Ingesting a doc authored elsewhere (e.g. an expert wrote chapter 2)

1. The file is in the bucket (uploaded any way you like), under the grade/subject's `documents/`.
2. `reconcile` surfaces it as untracked.
3. `get_document_text(relPath)` returns its plain text (server downloads from the bucket and extracts via mammoth — it never calls an LLM).
4. Extract the structured content and call `record_document_content(...)` (**requires confirmation** — call with `confirm: true` after the user approves). Tracked from then on.

## Reconciliation

Run on startup (when a context is active) and via the `reconcile` tool: present + md5 matches history → tracked (skipped); new/changed md5 → untracked (needs ingestion); in history but gone from the bucket → dropped; duplicates for one identity → the object matching the tracked md5 wins, else most-recently-updated.

## Tools

**Context (subject-agnostic):** `set_context`, `get_context`.

**Subject-agnostic** — work the same for any grade/subject: `get_terminology`, `terminology_sections`, `get_prompt`, `reconcile`, `list_documents`, `create_upload_url`, `create_download_url`, `get_document_text`.

**Subject-specific payloads** — generically named, but what they accept/return is shaped by the active subject's adapter:

- `list_units`, `get_curriculum`, `get_generation_context`, `record_document_content`, `log_generation`. These take a `unit` (the subject's scope value — a chapter for maths, a week for CE1 reading) and, where relevant, a `deliverable` key. The shapes are subject-specific: maths returns `chapitreNum`/`leconNum` etc., and the `content` payload (characters, example domains, amorce/bilan) follows the maths storybook model — all fields optional.
- *Capability-specific* (`exampleDomainRotation`, maths only) — `suggest_fresh_domain`, `domain_usage`. Example-domain rotation is a maths storybook feature; they are gated on the capability, so for a subject whose adapter doesn't enable it they return a `notApplicable` message instead of running.

## Setup

```bash
npm install
npm run build
```


### Production deployment (current state)

The server is **live on Cloud Run**: project `senegal-ci-maths`, region `europe-west1`,
service `senegal-mohebs-tlm`, capped at one instance.

- **Users connect** via a Claude custom connector pointing at
  `https://senegal-mohebs-tlm-148764688487.europe-west1.run.app/mcp`. First use runs an
  OAuth login (Supabase project `senegal-tlm-auth`, IDinsight org) on a consent page this
  server hosts at `/oauth/consent`.
- **Accounts** are created in the Supabase dashboard (Authentication → Users → *Create new
  user*, auto-confirm on). The invite-email flow is **not** supported yet — its link expects
  a password-setup page that hasn't been built.
- **A user's grade/subject selection is sticky per person** (persisted at
  `_state/<user-id>.json` in the bucket) because web clients open a fresh MCP session per
  tool call.
- **Merging to `main` does NOT deploy.** CI builds and tests only. To ship an update, from
  the repo root on `main`:

  ```bash
  gcloud run deploy senegal-mohebs-tlm --source . --region europe-west1 --project senegal-ci-maths
  ```

  Existing env vars and public-access settings are preserved. Full runbook incl. first-time
  setup, Supabase dashboard config, and post-deploy smoke checks: [`DEPLOY.md`](DEPLOY.md).

### Remote (HTTP) mode — central hosting

`npm run start:http` starts a Streamable HTTP server (for e.g. Cloud Run) instead of stdio.
Each MCP session gets its own active context and caches, so concurrent users can work on
different grades/subjects without interfering. Stdio mode (`npm start`) is unchanged.

| Env | Meaning |
|---|---|
| `PORT` | Listen port (default 8080) |
| `PUBLIC_URL` | This server's public base URL (required when auth is on) |
| `SUPABASE_URL` | `https://<ref>.supabase.co` — enables OAuth (Supabase Auth is the authorization server; this server only validates its JWTs) |
| `ALLOW_UNAUTHENTICATED` | `1` to run without auth — local testing only |

With auth on, unauthenticated calls get a 401 pointing at `/.well-known/oauth-protected-resource`,
which advertises the Supabase authorization server — MCP clients (e.g. Claude connectors)
discover the login flow from there. Every tool call is logged with the caller's identity.
`GET /healthz` is unauthenticated.

#### Per-request actor identity

Every MCP request is bound to a request-scoped `Actor` derived **only** from the
verified Supabase JWT (`sub`, `email`, `iss`) — see [`src/actor.ts`](src/actor.ts).
Tool handlers read the caller via `currentActor()` (nested inside the existing
`runInSession` context); tool arguments, request bodies, and client-settable
headers are never trusted for identity. Each non-GET request emits one
structured JSON audit line to stderr — `{ actor, tool, grade, subject, … }` —
as the seed for the audit store planned in a later phase.

**Defaulted decision — unknown-actor policy.** With `SUPABASE_URL` set the
bearer middleware 401s any unverified caller before we resolve an actor, so
`actor.unknown` is only reachable via `ALLOW_UNAUTHENTICATED=1` (local
testing). In that mode, unknown actors currently proceed since no roles are
enforced yet. Flip this by editing the `unknown-actor policy` block in
[`src/http.ts`](src/http.ts) — it is the one place to change.

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

The server supports many grades/subjects whose curriculum graphs and deliverables genuinely differ (CI maths is a `graph[]` of `Chapitre`/`OS` nodes; CE1 reading is `nodes`/`relationships` with a `hasChild` tree and no chapters). Behaviour is therefore **pluggable per subject**, not hard-coded — one **adapter module** per subject owns everything subject-specific in one place.

- **Subject adapter** (`src/adapters/*.ts`) — one module per subject. Each module exposes a common behavior interface: raw-graph `detect`/`parse` (the schema knowledge each subject already owns), the LC→friendly projection (`listUnits`/`slice`/`progression`/`requiredCoverage`/`scopeValues`), `buildGenerationContext`, plus the subject's `deliverables` and `capabilities`. Capability-gated helpers (`suggestFreshDomain`/`domainUsage`, only maths today) are optional on the interface. Storage round-trip is handled generically on top of the parsed model by `curriculum/store-bridge.ts` (`serializeModel` / `deserializeToModel`), so no serialize/deserialize methods hang off the adapter.
- **Adapter registry** (`src/adapters/index.ts`) — binds each `(grade, subject)` pair to an adapter builder. Resolution is many-to-one capable: several `${grade}/${subject}` keys may point at the same builder when their graphs share a shape, but different grades of the "same" subject stay independent by default — a graph with a different envelope registers its own adapter.

Adapters are **behavior only**. There is no `schema` field, no LC property/edge/cardinality declaration, and no integrity rules on the adapter — that's deliberate. The write-safety rules that will land in the next phase live *in the write tools*, not on the adapter (and they'll key on the raw LC IRI — the stored `id` is the LC UUID verbatim, and friendly properties like `chapitreNum`/`semaine` live inside `properties.raw`).

Modules are **layered, and imports only ever point down**. A build-time check (`npm run check:cycles`, run automatically by `npm run build`) fails on any import cycle:

```
app       server/* · index.ts · activate.ts
adapters  adapters/*                                     — one behavior module per subject
services  storage/* · curriculum/* · generation/* · kg-store/*   — never import adapters
core      config.ts · types.ts · context/{state,shared} · utils/*   — leaves
```

Cross-module imports go through each module's `index.ts` (barrel); files **inside** a module import their siblings directly. `activate.ts` (resolve the adapter → run the schema guard → bind the context) is app-layer glue that wires `context/` to `adapters/`, so it lives at the root next to `index.ts` rather than inside the leaf `context/` module. The full design rationale is in [`docs/multi-subject-architecture.md`](docs/multi-subject-architecture.md).

## Adding a new grade/subject

Adding a subject takes its **sources** (data) and an **adapter** (code). If the knowledge-graph shape matches one that's already registered, you can point a new `(grade, subject)` key at that adapter's builder — the registry is many-to-one on purpose.

1. **Drop in the sources** under `sources/<grade>/<subject>/`: `knowledge_graph.json`, `terminology.json`, the generation prompt(s), and optionally `example_domains.json`.

2. **Reuse or write an adapter** (`src/adapters/`):
   - *Same graph shape as an existing subject* → register the new `(grade, subject)` key against that subject's builder in `src/adapters/index.ts`. That's the many-to-one case.
   - *Different shape* → add `src/adapters/<subject>.ts` exporting a `buildXxxAdapter(grade, subject): SubjectAdapter`. The adapter carries everything: raw-envelope `detect`/`parse`, the LC→friendly projection (`listUnits`/`slice`/`progression`/`requiredCoverage`/`scopeValues`), the `deliverables` list (`key`, `label`, `scopeKind`, `classify(filename)`, `dependsOn`, `promptFile` — one per document kind), the `capabilities` flags (`exampleDomainRotation`, `characterConsistency`), and `buildGenerationContext(scope, deliverableKey)`. Optional maths-style helpers (`suggestFreshDomain`, `domainUsage`) are only added when the subject enables the matching capability.

3. **Register it** in `src/adapters/index.ts` under the `"<grade>/<subject>"` key (in the `REGISTRY` object). Grade × subject: e.g. `"ci/maths"` and `"cp/maths"` may point at the same builder or different ones — that's a per-pair choice, not an assumption.

4. **Build and select it:** `npm run build`, then `set_context("<grade>", "<subject>")`. The guard runs your adapter's `detect()` against the KG; on a mismatch it refuses to activate and says why — nothing is silently mis-parsed.

**No schema.** Adapters carry behavior only. If your subject needs write-safety rules (uniqueness, required properties, edge-type constraints), those will live in the write tools when they land — not on the adapter. The stored `id` for every node/edge is the raw LC IRI, verbatim; friendly properties (`chapitreNum`, `semaine`, `statementCode`) live inside `properties.raw` and must NOT be used as write-target identities.

**Rules the build enforces:** imports point *down* the layers above; **service modules (`storage`/`curriculum`/`generation`/`kg-store`) must not import `adapters`** — pass what they need in as arguments (as `reconcile(deliverables)` and `discoverDocuments(deliverables)` do); cross-module imports go through the module's `index.ts`. `npm run check:cycles` fails the build on any import cycle.

> **CE1 reading** is wired as a worked second subject (scope: one teacher guide **per week**), registered as `ce1/reading` — its adapter parses a `nodes`/`relationships` + `hasChild` graph. See `docs/multi-subject-architecture.md` §11 phase 4 for what its KG needed and the open follow-ups (no `terminology.json` yet; evaluation grids pending).

## Testing note

The storage layer sits behind a small `StorageAdapter` interface. The reconcile / history / variety / ingest logic is verified against an in-memory fake (no credentials needed). Unit tests run with `npm test` (Vitest); the example-domain neighborhood/suggestion logic is covered in `src/generation/domains.test.ts`. `npm run build` runs the import-cycle check (`npm run check:cycles`) before `tsc`, so a broken layer boundary fails the build. The **Firebase implementation is compile-checked but not live-tested here** — validating real bucket calls (list, signed URL, download, history read/write) needs your service-account credentials and network access, so do a first run against your own project.

## Assumptions still baked in (tell me to change any)

- One grade/subject is active at a time; switching drops the KG, terminology, and history caches so the next call reloads for the new context.
- Deliverable classification is per-subject (a profile's `DeliverableSpec.classify`). For CI maths: within a chapter subfolder, anything not "Fiches de leçons …" is the pupil manual.
- Glossary derives from the KG, with the FR/Wolof file as fallback; characters are derived from what you log/ingest.
- "Latest" among duplicates is the object whose md5 matches history, else the most recently updated.
