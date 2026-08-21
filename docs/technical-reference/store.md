## KG node/edge store

The curriculum knowledge graph lives in a generic node/edge store on Firestore — the
**single source of truth** (no on-disk `sources/` copy, no `bundle`/`KG_SOURCE` mode; see
[`firestore-only-store.md`](../design-notes/firestore-only-store.md)). The store holds the
**complete raw Learning-Commons graph** (spine + framework/derived nodes + every real edge),
so it can be re-exported faithfully. Collections, each namespaced by
`${TLM_BUCKET_PREFIX}<workspace>/<grade>/<subject>` (the same key the docs bucket and history
use):

- **`kg_nodes`** — one doc per LC node: `{ id, type, namespace, labels, spine, properties }`. `id` is the LC UUID verbatim (never regenerated). **Spine** nodes (the parsed curriculum units) carry `spine: true` and normalized fields (`code, title, text, order, isAssessment`) alongside the raw graph passthrough under `properties.raw`; **framework/derived** nodes carry `spine: false` and `raw` only (`type` = their first LC label). The parser rebuilds the spine `CurriculumModel` from these on hydration.
- **`kg_edges`** — one doc per LC relationship: `{ id, type, from, to, namespace, properties }`. `type` is the **real LC edge type** — `hasChild` (standards hierarchy), `hasPart` (content containment), `hasEducationalAlignment` / `supports` (alignment), `relatesTo`, `buildsTowards`. `id` is deterministic — `edgeId(type, from, to)` — so re-linking the same triple is a detectable duplicate and diff-by-id is stable.
- **`kg_pointers`** — one doc per namespace: the draft/published pointer plus per-slot side cells (see below).
- **`kg_audit`** — the append-only audit log (see [Audit log](#audit-log-append-only-atomic-with-the-change)).
- **`kg_pending`** — parked confirm payloads for token-only confirm (see [The curator loop](#the-curator-loop--end-to-end)).

### Import / export

A graph is added on demand and backed up on demand:

```bash
npm run import:kg-store -- <workspace> <grade> <subject> <graph.json>   # write a namespace's published data
npm run export:kg-store -- <workspace> <grade> <subject> [out.json]     # dump a namespace's published graph
```

Both need the Firebase credentials the server uses (`SERVICE_ACCOUNT_KEY_PATH` or
`SERVICE_ACCOUNT_KEY_JSON`, and `FIREBASE_STORAGE_BUCKET`), and `TLM_BUCKET_PREFIX` matched to
the runtime prefix so the namespace lines up. `import-kg` also seeds the subject-profile config
cell from `--profile <path>` or the in-repo literal. The exported JSON is a raw Learning-Commons
envelope (`{ nodes, relationships }`) — feed it back to `import-kg` to restore or clone a graph.
Context discovery is store-backed: the server lists its namespaces at startup, so an imported
graph shows up on the next boot. See [Interchange](#interchange-export--import-round-trip).

> **⚠️ `import-kg` writes the published data directly and does not merge.** On a **new**
> namespace it initialises the pointer; on an **existing** one it prints a WARNING. To publish a
> corrected graph into a live namespace, prefer staging it through the curator loop over
> re-importing. The `--replace-published` flag exists for a deliberate full-graph replacement.

### Draft/published state — canonical + overlay

Each namespace has a **published** graph (the canonical `kg_nodes` / `kg_edges` docs) and, when
someone is editing, a **draft**. A small **pointer doc** (`kg_pointers/<nsSlug>`) records
`publishedSlot` and the optional in-progress `draftSlot`. **Generation always reads published**,
so an in-progress draft can never leak into produced materials.

The draft is a **changeset overlay, not a copy** (see
[`canonical-changeset-store.md`](../design-notes/canonical-changeset-store.md)). A draft slot
stores only the docs an editing session **changed** — plus **tombstones** (`{id, …, _tombstone:true}`)
for ids it deleted. A draft read merges the canonical layer with the overlay: overlay docs win by
id, tombstones mask. This is why opening a draft is near-instant (no byte-for-byte copy of the
whole graph) and a draft holding one edit is one overlay doc.

- **create draft** sets `draftSlot` in the pointer — an empty overlay on top of canonical. Idempotent: a no-op when a draft already exists.
- **publish draft** folds the overlay into canonical: for a **small** publish (≤ `PUBLISH_TXN_MAX` overlay docs) one transaction applies each overlay doc to canonical (upserts + tombstone-deletes), clears the overlay, moves the pointer, and joins the audit — all atomically; `publishedSlot` need not flip. A **large** publish takes a scratch-and-swap fallback (materialise the merged graph into the free slot, then flip the pointer). Either way, readers see the pre- or post-publish graph, never a mix.
- **discard draft** clears `draftSlot`; the orphaned overlay docs are inert and get overwritten by the next draft.

**Session read-model refresh (important).** The publish is atomic *in the store*, but a live
session does not re-read the store on every call: `activate.ts` hydrates the published
`CurriculumModel` **once** at `set_context` and pins it in the session bag (`PRELOADED_MODEL_KEY`);
the adapter reads that snapshot synchronously. So a `publish_draft` in the same session must
invalidate that snapshot, or reads keep serving the pre-publish graph. `publish_draft` does this:
on a successful commit it calls `refreshActiveContext()`, which re-hydrates the published model
(and rebuilds the adapter from the newly-published profile cell); the commit response reports
`readModelRefreshed`. To make a read/write disagreement visible, `walk_graph` and `namespace_stats`
echo `physicalSlot` — the slot the returned data was hydrated from (`PRELOADED_SLOT_KEY`). A
cross-*session* publish is not auto-refreshed: another in-context session keeps its snapshot until
it re-enters `set_context` (or publishes itself).

**Per-slot side cells.** The pointer doc also carries, per slot, the `meta` provenance stamp
(`{ contentHash, seededAt, adapterId, nodeCount, edgeCount }`) and the **subject-profile config**
cell (`configA` / `configB`). The profile is opaque JSON to the store (its schema lives in the
adapters layer) and is a `{ core, guide }` record: the machine `core` (parsing config) plus the
authored markdown `guide` the LLM reads via `get_graph_guide`. Both cells ride the same lifecycle
as the slot they belong to, so a publish swaps the current meta and profile atomically with the
graph. `activate.ts` builds the subject adapter from the published profile cell (falling back to
the in-repo literal when a namespace has no cell), and `get_profile` / `edit_profile` read and
stage it through the same two-phase loop as a graph edit — so a subject's parsing config is
authored data, no redeploy. See [`authorable-catalog.md`](../design-notes/authorable-catalog.md).

### Graph-mutation framework (draft-only apply)

A **graph mutation** is a pure function over `{nodes, edges}`. The framework in
[`src/kg-store/mutations.ts`](../../backend/src/kg-store/mutations.ts) gives every mutation the same
two-phase confirm plumbing:

- **preview** (no `confirm`) → runs the structural rules, computes a `diff` keyed by stable id, parks the confirm payload in `kg_pending`, and returns `diff` + `warnings` + a `confirmationToken`. Changes NO state.
- **confirm** (`confirmationToken` only — no re-sent payload) → re-checks the token (base version current, nonce unused, mutation + args match), lazily opens a draft if none exists, then applies to the **draft overlay** only. Published is untouched.

Because the caller confirms with just the token, a large batch's payload crosses the wire once
(see [token-only confirm](../design-notes/kg-mutations/token-only-confirm.md)). The framework
uses only stable ids (LC UUIDs for nodes; deterministic `edgeId` for edges) — friendly properties
like a source ordinal live in `properties.raw` and are NEVER identity. A stale or replayed token is
rejected cleanly with no partial apply. Full design note:
[`docs/design-notes/kg-mutations/`](../design-notes/kg-mutations/README.md).

### Write-safety rules (structural only)

Every graph mutation passes two shared structural rules in
[`src/kg-store/validate.ts`](../../backend/src/kg-store/validate.ts) before the human review gate. Errors
from either rule **block confirmation** — no token is issued, so there's nothing to replay.

- **Rule 1 (id-immutable).** A node's id is its LC UUID; an edge's id is `edgeId(type, from, to)`. Every reference points at these ids, so a silent rename would orphan everything a reviewer can't see in a diff. The rule compares the proposed state to the **currently-published** graph, so a delete-then-recreate-with-matching-content sequence on the same draft is caught as a disguised rename — whether inside one mutation or across several. A legitimate delete-then-create with genuinely different content passes.
- **Rule 2 (no-orphan).** After the edit, every edge's `from` and `to` must resolve to a node in the graph. A delete that would strand an incident edge is refused; a cascading delete re-runs Rule 2 on the *result* to prove the cascade itself left nothing dangling.

**We don't check content.** Whether a title reads well or a number is sensible is what the draft →
review → publish gate is for. The machine guards only the two errors a reviewer can't eyeball; a
mutation may add its own `validate(base, after, args)` on top, and both layers compose.

### Referential integrity — block vs warn

- **BLOCK (error, no token)** — anything that leaves the graph **referentially broken**: a dangling edge, a reference to a node that won't exist post-edit, a disguised rename (Rule 1). Subject-agnostic, in [`validate.ts`](../../backend/src/kg-store/validate.ts).
- **WARN (informational, still confirmable)** — a change that is valid but destructive-if-unintended: a **cascading delete** surfaces the full set of nodes/edges that will vanish as a warning on the dry-run and `diff_draft`. It never blocks; seeing the cascade before confirming is the safety.
- **Completeness is a review step, not an automatic warning.** The old coded coverage rules (empty chapter, missing bilan, …) were **retired** — edits, `diff_draft`, and publish no longer emit automatic coverage warnings. A subject's coverage expectations are authored as prose in its graph guide, and **`review_draft`** (read-only) bundles those expectations with a subject-agnostic structural snapshot for the calling model to reason over. The server never runs the review itself.

Every cross-entity link is an **id-based edge**, so renumbering a grouping or moving a lesson is a
pure edge/attribute operation with nothing to keep in sync. CI maths lessons legitimately carry two
containment parents (a grouping via `hasPart` + a week via `hasChild`).

### Audit log (append-only, atomic with the change)

Every state-changing graph operation writes a record to the append-only `kg_audit` collection.
`KgNodeStore.listAudit(filter)` filters by namespace, actor id, event type, and time range
(newest first). No update/delete method exists on the interface, and the write path uses `set` on a
fresh doc id only. The supported way to review it through the MCP is the
[`read_audit`](#read_audit--reviewing-the-trail-approver-only-read-only) tool.

Events: **`apply`** (a mutation landed on the draft — carries the diff inline, plus `baseVersion` /
`resultingVersion` hashes), **`createDraft`**, **`publish`** (references `promotedApplyIds`,
`selfAuthored`), **`discard`** (references `discardedApplyIds`), **`preview`** (a preview
generation), **`read`** (an audit review), and **`blocked`** (a rejected mutation — structural rule
failure, custom validate error, token mismatch, or an authorization denial; lightweight `{ actor,
ts, namespace, mutation, reason }`).

**Atomicity.** Each committed-change record is written in the SAME Firestore transaction as its
state write (the pointer/publish transaction the audit doc joins), so the log never carries a
phantom record for a change that didn't happen, and a committed change is never unlogged — except
inside the pre-existing bulk-write partial-failure window, where a crash can leave both the draft
inconsistent and no audit written (reliability of the audit equals reliability of the state write).

**Who.** The actor is captured verbatim from the verified identity — including `actor.unknown`
when none is available (reachable only via `ALLOW_UNAUTHENTICATED=1`, local testing). The audit
records who *tried*; it does not restrict anyone. The document tools (`create_upload_url`,
`log_generation`, `record_document_content`) write to the bucket / history on a separate lifecycle
and are not audited here.

### Curator / approver roles

Authorization is **per workspace** (the workspace is the first path segment of the namespace; see
[`workspaces.md`](../design-notes/workspaces.md)). Roles form ranked tiers — each is a superset of
the one below:

- **`curator`** — apply / dry-run graph mutations, discard a draft, read a draft. May NOT publish.
- **`approver`** — + publish a draft, read the audit trail.
- **`admin`** — + manage the workspace's members.
- **`super_admin`** — universal across every workspace (env-rooted).
- **No role / unknown actor** — can read and generate; cannot mutate. Reads and generation are never gated by role. But *entering* a workspace (`set_context`) requires a role in it.

**Authorization derives ONLY from the verified identity.** Per-workspace memberships live in a
Firestore registry, are resolved **once per request** by the app layer, and are attached to
`actor.memberships` — no tool argument, header, or client-settable field can influence the
decision. A **legacy bridge** still honours a global Supabase `app_role` claim, but only in the
`senegal` workspace, during migration; it is removed once memberships are fully populated. See
[`src/authz.ts`](../../backend/src/authz.ts) and [`src/actor.ts`](../../backend/src/actor.ts).

**Separation of duties.** By default an approver may publish a draft they authored
(`TLM_ALLOW_SELF_APPROVE`, default `"1"`). Set it to `0` to require a second reviewer — publish is
then denied if any promoted `apply` was authored by the same approver. Regardless, every `publish`
audit record carries `selfAuthored: boolean`.

**Enforcement point.** Role checks live at the Firestore write chokepoint (`runGraphMutation`,
`publishDraft`, `discardDraft`). A denied mutation returns `phase: "unauthorized"` (distinct from
`"blocked"` validation errors and stale-token errors), issues no token, changes no state, and
writes a `blocked` audit record with a `reason` starting `"unauthorized: …"`. Member management is
its own tenant-admin surface (`add_member` / `remove_member` / `list_members`), gated at `admin`.

### The curator loop — end to end

The loop is a set of role-gated MCP tools over the draft:

- **Authoring (curator+):** `add_nodes`, `create_edges`, `edit_node`, `move_node`, `delete_nodes`, `delete_edges` — see [Authoring verbs](#authoring-verbs) below. Each is two-phase (dry-run → token-only confirm) and audited on both writes and denials. Sequential edits accumulate on the SAME draft overlay and publish together atomically.
- **`diff_draft`** (curator+) — read-only. The CUMULATIVE draft-vs-published diff: everything that goes live on publish.
- **`review_draft`** (curator+) — read-only. The guide's coverage expectations + a structural snapshot, for the model to reason over before publishing.
- **`publish_draft`** (approver only) — two-phase: dry-run shows the whole-draft diff + a draft-level token; confirm folds the overlay into canonical atomically. If the draft moved since dry-run, confirm is rejected (retry).
- **`discard_draft`** (curator+) — two-phase: dry-run shows what will be thrown away; confirm drops the draft. Published is byte-untouched. Audited.

```
curator:  add_nodes([...]) / edit_node(...) → dry-run: diff + token
curator:  <same tool>(confirm:true, confirmationToken:…) → applied to the draft overlay
approver: diff_draft()   → the whole-draft diff
approver: review_draft() → coverage expectations + structural snapshot
approver: publish_draft() → dry-run: diff + draft-level token
approver: publish_draft(confirm:true, confirmationToken:…) → live; generation now reads the new graph
```

### Authoring verbs

The edit surface is **generic and subject-agnostic** — it speaks pure canonical Learning-Commons
(no chapter/domaine/week vocabulary, no per-subject allowlist) and is available on every subject
(validity is structural). It is mirrored by `get_capabilities`.

- **`add_nodes`** — create one node or many in one atomic batch. Each item is a `kind` (the LC `label`) + a free `properties` bag of canonical LC props written under `raw.*` (`content`, `materialType`, `studentGroupingType`, `educationalUse`, `groupName`, …), attached under `parentId` via the canonical containment edge (`hasPart` for content, `hasChild` for standards), at a `position` (append default), optionally aligned to a `StandardsFrameworkItem` (`alignTo` → `hasEducationalAlignment`). The new node's **LC identity is derived from the graph** — labels, `normalizedType`, role, and its raw ordinal path(s) are copied from an existing node of the same label (canonical defaults for the first of its kind). Ids are minted server-side and surfaced on the dry-run (`mintedNodeIds`, in item order). It **replaced the per-label typed adds** (`add_lesson` / `add_material` / …); each kind's property vocabulary is catalogued in `get_capabilities` under `editable.batch.kindProperties`. (The single-node `add_node` verb underlies it.)
- **`create_edges`** — add one edge or many in one atomic batch (`usesRoutine` / `buildsTowards` / `relatesTo` / `hasDependency` / an extra `hasEducationalAlignment`). Edge ids are deterministic; duplicate detection spans the batch AND the draft; edge-type LEGALITY across labels is deferred to human review at publish.
- **`edit_node(nodeId, [content, position, title, title_en])`** — edit a node's fields in place. `content` replaces the load-bearing content (`Material.content`); `position` sets the ordinal among siblings (membership is the edge, so this **never cascades**); `title` / `title_en` set the display name (normalized to the node's `title` vs `text` field by its label, + `raw.description`). It consolidated `reposition` + `set_content` and added title editing. Edit in place — never delete + re-add (that cascades the subtree, drops edges, and mints a new id).
- **`move_node(nodeId, toParentId, [via, position])`** — re-parent along one containment axis. A node's second axis (e.g. a maths lesson also scheduled under a week via `hasChild`) is left intact.
- **`delete_nodes`** — remove one node or many; each together with its **dependent subtree** (children, their children, …) and every incident edge, in one atomic batch. The dry-run diff shows the full set that will vanish and WARNS with it; nothing is removed until you confirm — no `force` flag, because seeing the cascade IS the gate.
- **`delete_edges`** — remove one edge or many by id, all-or-nothing.

**Batch ergonomics.** Each batch is one atomic draft edit → one diff → one token → one audit
record. The response is a compact `counts` summary by default (`returnMode:"full"` for the whole
diff), and an optional `idempotencyKey` (a client-chosen UUID) makes a retried confirm a safe
replay — same key + same payload replays the first apply's summary (`replayed:true`, no
double-apply); a different payload returns `IDEMPOTENCY_KEY_MISMATCH`. Keys are namespace-scoped
and expire after 24h.

**Positions are the single ordinal concept.** A node's `position` lives in the normalized
top-level `order`, mirrored into `raw` at the source's own path(s) (CI maths carries both
`raw.position` and `raw.metadata.order`; reading uses `raw.position`). `add_nodes` writes every
path its copied example uses, and `edit_node` / `move_node` write every path the node itself uses —
so a created, moved, or repositioned node round-trips faithfully with no per-subject alias config.

### `get_capabilities` — a truthful mirror of "what can I do?"

`get_capabilities` reports, for the authenticated caller and the active workspace/grade/subject,
what they can do — **every field sourced from the module that enforces it, never a copy:**

- **actor** — verified id, whether known, and the effective role, all from the identity/membership resolution — never client-supplied.
- **actions** — `canReadGenerate` / `canReadDraft` / `canEditDraft` / `canDiscardDraft` / `canPublish` / `canReadAudit`, **each computed by calling `authorize()`** — the same function every write tool uses.
- **audit** — advertises `read_audit` (approver-only), mirroring the same `authorize(actor, "readAudit", ns)` gate.
- **draft** — whether a draft is open, and (from the audit log) who created it and when.
- **editable** — the live edit surface: `batch` (the `add_nodes` / `create_edges` tools + the per-kind `kindProperties` catalog + the response/idempotency controls), `structural.verbs` (`create_edges` / `delete_edges` / `delete_nodes`), and `recipes` (a mirror of the generic `RECIPES` registry — `edit_node` / `move_node`), all rendered straight from source.
- **rules** — the structural rules (id-immutable, no-orphan) as descriptions imported from `validate.ts`, plus the two-phase confirm expectation.

**Guarantee.** A mirror-property test asserts, for every role and gated action, that
`get_capabilities.actions.canX === authorize(actor, X, ns).ok`. If they ever disagree, one is a
copy that drifted — the test catches it. Available to any caller: an unknown user gets a truthful
"read/generate only" response, not a 401.

### `read_audit` — reviewing the trail (approver-only, read-only)

`read_audit` is a filtered, paginated, **read-only** view over the append-only audit log — the
supported way to review the trail through the MCP. It is a reader, not analytics: query → page of
records; no dashboards, aggregations, or exports.

- **Approver-only, read-only, namespace-scoped.** Gated through the same `authorize()` chokepoint as publish (a `readAudit` action). A curator or no-role/unknown caller is blocked — and the blocked read is itself audited. Scope is the caller's current `set_context` namespace; there is no namespace argument (to review another, `set_context` to it first).
- **Filters** (optional, AND-combined): `actor`, `action` (`apply` / `createDraft` / `publish` / `discard` / `blocked` / `preview` / `read`), `outcome` (`applied` vs `blocked`), `nodeId` (entries whose `apply` diff touches that node or an incident edge), `since` / `until` (inclusive ISO-8601).
- **Pagination & ordering.** Newest-first, page size `limit` (default 25, max 100), with an opaque cursor — pass the returned `nextCursor` back to walk the log with no overlap.
- **Modes.** `summary` (default) returns compact rows (`auditId`, `ts`, `actor`, `action`, `outcome`, `namespace`, a one-line `target`, `selfAuthored` on publishes) with no before/after; `detail` (or passing an `auditId`) returns the full record including the before/after `diff`.
- **The read-event.** Each successful call appends exactly one lightweight `read` audit event (`actor` + a compact `readQuery` + `ts` + `readCount`) — appended after the query returns, so growth is linear, never recursive. "Who reviewed the trail, with what query" stays answerable via `action: "read"`.

### Interchange (export → import round-trip)

The store is the only source of truth, so there is no bundle-vs-store parity check to keep in sync.
The one round-trip that matters is **export → import**: `export-kg` reproduces the raw LC envelope
(`toRawEnvelope` is exact, since the store holds the full raw graph), and feeding that JSON to
`import-kg` reconstructs an equivalent namespace. That is the backup/restore and clone-a-graph path.
