## KG node/edge store

Curriculum + KG data can live in a generic node/edge store on Firestore, so
later steps can expose editing tools without rewiring the read layer. Two
collections, each namespaced by `${TLM_BUCKET_PREFIX}<grade>/<subject>` (the
same key the docs bucket and history use):

- `kg_nodes` — one document per curriculum unit: `{ id, type, namespace, properties }`. `type` is the adapter-produced kind (CI maths: `chapter, lesson, component, task`; CE1 reading: `week, standard, component`). `properties` carries the normalized fields (`code, title, text, order, isAssessment`) plus the raw graph passthrough under `raw`. Ids are the verbatim UUIDs from the bundled KGs — never regenerated.
- `kg_edges` — one document per adapter-produced link: `{ id, type, from, to, namespace, properties }`. `type` is either `hasChild` (parent→child hierarchy) or `buildsTowards` (CI maths cross-chapter progression). `properties` records `orderInParent` / `sequenceInFrom` / `sequenceInTo` so child and progression ordering round-trip byte-identically.
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

The pointer doc also carries two per-slot side cells: the `meta` provenance stamp and the **subject-profile config** (`configA`/`configB`, phase 2b). The profile is opaque JSON to the store (its schema lives in the adapters layer). Both cells ride the same lifecycle as the slots they belong to: `create draft` copies published → draft, `publish` promotes with the pointer flip, `discard` clears the draft cell. In firestore mode `activate.ts` builds the subject adapter from the published profile cell (falling back to the in-repo literal when a namespace predates the config layer), and the `get_profile` / `edit_profile` MCP tools read and stage it through the same two-phase loop as a graph edit — so a subject's parsing/deliverables/coverage config is authored data, no redeploy. See [`authorable-catalog.md`](../design-notes/authorable-catalog.md) (phase 2b).

These lifecycle functions live on the internal `KgNodeStore` interface — **no user-facing MCP tools are exposed yet**. Tool-facing wrappers for `create_draft` / `publish_draft` / `discard_draft` (and a `diff_draft`) land in a later step (#10). Preview generation against a draft (#15) will use the draft-read path that this step lays down but doesn't expose.

### Graph-mutation framework (draft-only apply)

Sits on top of the draft/published split. A **graph mutation** is a pure function over `{nodes, edges}` — e.g. "set property X on node Y", "delete node Z". The framework in [`src/kg-store/mutations.ts`](../../src/kg-store/mutations.ts) gives every new mutation the same two-phase confirm plumbing for free:

- **preview** (no `confirm`) → runs `validate` (empty seam today; #6 fills it), computes a per-mutation `diff` keyed by stable id, and returns the shared confirmation envelope extended with `diff`, `warnings`, and a `confirmationToken`. Changes NO state.
- **confirm** (with the `confirmationToken`) → verifies the token matches the mutation + args + base-version + is unused, lazily creates a draft if none exists (byte-for-byte from published), then applies the mutation to the **draft slot only** via `writeSlot`. Published is unaffected — publish is a separate step (#10).

The framework uses only stable ids (LC IRIs for nodes; deterministic `edgeId(type, from, to)` for edges) — friendly properties like `chapitreNum` live in `properties.raw` and are NEVER used as identity. A stale token (base moved between preview and confirm) or a replayed token is rejected cleanly with no partial apply. See [`docs/design-notes/kg-mutations/`](../design-notes/kg-mutations/README.md) for the full design note, decisions, and the mutation interface.

**No user-facing graph edit tool ships in this step.** The framework has exactly one test-only mutation, wired inside `mutations.test.ts` — real edit tools (`upsert_property` / `create_node` / `delete_node` / `link_nodes`) land in #11/#12.

### Write-safety rules (structural only)

Every graph mutation goes through two shared structural rules in [`src/kg-store/validate.ts`](../../src/kg-store/validate.ts) before the human review gate. Errors from either rule **block confirmation** — no token is issued, so there's nothing to replay.

- **Rule 1 (id-immutable).** A node's id is the LC IRI verbatim (or, for a `create_node`-minted node, a randomUUID); an edge's id is `edgeId(type, from, to)`. Every reference in the graph points at these ids, so a silent rename would orphan everything the reviewer can't easily see in a diff. The rule compares the proposed state to the **currently-published** graph (not just the pre-mutation state) — a removed-since-publish node and an added-since-publish node with matching content are treated as a rename attempt and rejected, whether the pair occurs inside one mutation OR across a delete+create sequence on the same open draft. Legitimate delete-then-create (genuinely different content) passes.
- **Rule 2 (no-orphan).** After the edit, every edge's `from` and `to` must resolve to a node in the graph. This subsumes "no removed node has surviving edges targeting it." Load-bearing since #12: a plain `delete_node` is REFUSED if any incident edge survives. A `force:true` delete cascades the dependent subtree and all incident edges in one atomic mutation, and Rule 2 re-runs on the *result* to prove the cascade itself left nothing dangling — so even the forced path can't produce a broken graph.

**Denylist = just the `id` key** (on nodes and edges). References in this graph are edges-only at the storage level — `properties.raw` carries content and match-keys, never a stored id pointing at another node — so there are no reference-bearing properties to protect. If a future subject introduces one, the denylist extends by a single entry.

**We don't check content.** Whether a title reads well, whether a number is sensible, whether wording matches the KG's own — that's what the draft → review → publish gate is for. A reviewer sees the whole diff and approves it. The machine only guards the two errors a reviewer can't eyeball; anything else would drift toward the schema we deliberately don't build.

A mutation may still add its own `validate(base, after, args)` on top of the shared rules for anything only it can decide; both layers run and their errors compose.

### Referential integrity — block vs warn

The integrity layer draws one line, applied consistently:

- **BLOCK (error, no token)** — anything that would leave the graph **referentially broken**: a dangling edge, a reference pointing at a node that won't exist post-edit, a disguised rename (Rule 1). This is corruption a reviewer can't see in a diff, so the machine refuses it outright. These are the shared, subject-agnostic rules in [`validate.ts`](../../src/kg-store/validate.ts).
- **WARN (informational, still confirmable)** — structural **incompleteness that is valid-but-suspect**: a chapter with no lessons, a chapter missing its bilan, a lesson linked to more than one *chapter* (its week parent is a separate axis and expected). A curator may legitimately be mid-edit, so these never block; the approver decides. Warnings ride the dry-run response and `diff_draft`, and are recorded on the publish audit (`warningsAtPublish`) for traceability — but publish proceeds.
- **CASCADE only on explicit `force`** — never silent, and the dry-run diff shows the full set that will vanish (see `delete_node` below).

**Where the two live.** The BLOCK rules are universal — they know only nodes and edges, never "chapter" or "bilan" — so they sit in the shared `kg-store` layer. The WARN rules are *unit-shaped* — they depend on what a unit IS for a given subject — so they live behind an optional adapter hook, `SubjectAdapter.coverageWarnings(graph)`. Subject-neutral shapes (empty container, a child with two parents) are reusable helpers in [`curriculum/coverage.ts`](../../src/curriculum/coverage.ts) that any adapter calls with its own kind names; genuinely subject-specific rules (the CI maths bilan; a lesson with more than one *chapter* parent) are written in the CI maths adapter. CE1 reading uses the generic helpers only. Nothing subject-specific leaks into the shared layer.

**The reference regime.** Every cross-entity link in the store is an **id-based edge** (`hasChild`, `buildsTowards`) — Rule 2 covers them all. Grouping↔lesson membership is the `hasChild` edge, so renumbering a grouping or moving a lesson is a pure edge/attribute operation with nothing to keep in sync. (CI maths lessons carry a second `hasChild` axis — a `week → lesson` schedule edge alongside the `LessonGrouping → lesson` content edge — so a lesson has two parents by design; the multi-parent coverage rule is scoped to *grouping* parents.)

### Audit log (append-only, atomic with the change)

Every state-changing graph operation writes a record to a single append-only Firestore collection `kg_audit`. Query surface: `KgNodeStore.listAudit(filter)` filters by namespace, actor id, event type, and time range (newest first). No update/delete method exists on the interface, and the write path uses `set` on a fresh doc id only — never `update()`, never `delete()`. A future Firestore security rule can lock this in externally. The supported way to **review** this log through the MCP is the `read_audit` tool (see below) — it replaces the manual Firestore-console check.

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

### Curator / approver roles

Two server-side authorization roles gate every graph state change:

- **`curator`** — may apply / dry-run graph mutations and discard a draft. May NOT publish.
- **`approver`** — superset: everything a curator can, plus publish (promote a draft to published).
- **No role** — signed-in but no `user_roles` row: can read and generate; cannot mutate. **Unknown actor** — same treatment. Reads and generation are never gated by role.

**Authorization derives ONLY from the verified Supabase identity.** The role is delivered as an `app_role` claim on the Supabase JWT — same trust channel as `sub` / `email`. No tool argument, header, or client-settable field can influence the decision. See [`src/authz.ts`](../../src/authz.ts) and [`src/actor.ts`](../../src/actor.ts).

**Where roles live.** The `public.user_roles` table in Supabase is the source of truth. A **Custom Access Token Hook** (Supabase → Authentication → Hooks) reads it and injects `app_role` into the JWT at token-mint time — zero extra I/O at request time; the MCP just reads the already-verified claim. Setup SQL: [`scripts/supabase-user-roles.sql`](scripts/supabase-user-roles.sql).

**Bootstrap.** Run the SQL script once via the Supabase dashboard SQL editor, then enable the hook in Authentication → Hooks → "Customize Access Token (JWT) Claims" pointing at `public.custom_access_token_hook`. Grant the first approver with `insert into public.user_roles (user_id, role) values ('<uid>', 'approver');` in the SQL editor. Further grants happen the same way. **The MCP server exposes no role-management tool** — self-escalation surface is zero.

**Separation of duties.** By default an approver may publish a draft they authored edits in (`TLM_ALLOW_SELF_APPROVE` env, default `"1"`). To require a second reviewer, set `TLM_ALLOW_SELF_APPROVE=0` — publish is then denied if any promoted `apply` record was authored by the same approver. **Regardless of the flag**, every `publish` audit record carries `selfAuthored: boolean` so a reviewer can spot self-approval even when permitted.

**Enforcement point.** Role checks live in the MCP server at the Firestore write chokepoint (`runGraphMutation`, `publishDraft`, `discardDraft` in [`src/kg-store/mutations.ts`](../../src/kg-store/mutations.ts)). Supabase Row Level Security guards direct Postgres access to `user_roles`, but the graph write itself lands in Firestore — RLS doesn't cover that, so the MCP is where enforcement has to be.

**Denial shape.** A denied mutation returns `phase: "unauthorized"` (distinct from `phase: "blocked"` for validation errors and `phase: "apply" ok:false` for stale-token errors). No confirmation token is issued, no state changes, and a `blocked` audit record is written with `reason` starting `"unauthorized: ..."`.

**Not gated here.** The document tools (`create_upload_url`, `log_generation`, `record_document_content`) remain open — this step covers graph writes only. A follow-on could extend role-gating to document writes if desired.

### The curator loop — end to end

Four MCP tools close the loop:

- **`diff_draft`** — read-only. Returns the CUMULATIVE draft-vs-published diff for the active grade/subject. This is the "approver's view" — everything that will go live on publish. Curator + approver only; unknown/no-role callers are blocked (a draft is pre-publish work-in-progress).
- **`upsert_property(nodeId, key, value)`** — the first real edit. `key` is a **logical** wording name (`"title"`, `"text"`, `"title_en"`, `"text_en"`); the active subject's adapter (`SubjectAdapter.wordingAliases`) resolves it to the concrete storage paths its wording lives under, and updates them **atomically in one call**. For CI maths chapters, `title` covers both `properties.title` (what presenters read) and `properties.raw.description` (the source-truth) — the curator doesn't need to know the storage layout. Two-phase confirm from #5: dry-run returns a per-mutation diff + token; confirm applies to the draft. Curator + approver.
- **`publish_draft`** — approver only. Two-phase: dry-run shows the whole-draft diff + a draft-level token; confirm promotes atomically via #7's audit, with self-authorship marked per #8. If the draft moved since dry-run (someone else edited), confirm is rejected (retry).
- **`discard_draft`** — curator or approver. Two-phase: dry-run shows what will be thrown away; confirm drops the draft. Published is byte-untouched. Audited.

**Two kinds of diff.** `upsert_property`'s dry-run returns a **per-mutation diff** — what THIS edit alone would change. `diff_draft` and `publish_draft`'s dry-run return the **whole-draft diff** — the cumulative view across every edit landed on the draft. They coincide when the draft has one edit; they diverge with more.

**Wording edit surface.** Only logical keys `title` / `text` / `title_en` / `text_en` are editable via `upsert_property`, only on node kinds the adapter declares them for, and only when the underlying storage paths currently hold a non-null string (the "existing key" rule: fix wording that's there, don't create new fields). A central `UPSERT_PROPERTY_SAFE_PATHS` allowlist inside the mutation is the safety net — a rogue adapter can't expand the editable surface by declaring an unlisted path. `upsert_property` stays **wording-only**; editing STRUCTURAL properties of existing nodes (a chapter's `order`/number, a lesson's position) is done through the composite **recipes** (see "Curriculum recipes" below), which have their own separate `STRUCTURAL_EDIT_SAFE_PATHS` allowlist.

**End-to-end example** (assuming set_context is done):

```
curator: upsert_property(nodeId=..., key="title", value="…") → dry-run: diff + token
curator: upsert_property(..., confirm:true, confirmationToken:...) → applied to draft
approver: diff_draft() → sees the whole-draft diff (1 change)
approver: publish_draft() → dry-run: diff + draft-level token
approver: publish_draft(confirm:true, confirmationToken:...) → promoted, generation now reads the new wording
```

### Structural verbs (create / link / unlink / delete)

Four RAW structural primitives, each a single #5 mutation on top of the same #5/#6/#7/#8 seams as `upsert_property`. Deliberately verbs-only — no cascade, no composite recipes:

- **`create_node(kind, properties)`** — adds a new node. **The server MINTS the id** (returned as `mintedNodeId` in the dry-run response); a caller-supplied id in `properties` is hard-rejected. `kind` must be a node kind already present on this namespace (chapter/lesson/component/task for CI maths). Missing wording surfaces as a WARNING, not a block — the reviewer at publish is the completeness gate.
- **`link_nodes(edgeType, fromId, toId, properties?)`** — adds an edge. Edge id is deterministic (`<type>:<from>-><to>`) so re-linking the same triple is rejected as a duplicate. Endpoints must exist and `edgeType` must be an edge type already present on this namespace (`hasChild` / `buildsTowards` for CI maths). Edge-type LEGALITY across kinds (does `hasChild(task→chapter)` make sense?) is NOT enforced — that judgment is deferred to human review at publish.
- **`unlink_nodes(edgeId)`** — removes one edge by id. Removing an edge cannot orphan a node (Rule 2 only cares about surviving edges).
- **`delete_node(nodeId, force?)`** — removes a node. By default (**`force:false`**) it is REFUSED if the node still has incident edges; the validate hook lists them so it's clear what to `unlink_nodes` first. With **`force:true`** it cascade-deletes the node together with its **dependent subtree** (its `hasChild` children, their children, …) and every edge touching any removed node, in ONE atomic mutation — the dry-run diff shows the full set that will vanish, and Rule 1/2 re-run on the result to prove it stays clean. Siblings and progression neighbours survive (only their connecting edge drops). **Cascade never happens without explicit `force`.**

Every primitive is two-phase (dry-run → confirm), curator- or approver-only, audited on both writes and denials. Multi-primitive sequences accumulate on the SAME draft and publish together atomically via the existing `publish_draft` flow — there is no single-call composite in this step; composite recipes (add-chapter, split-chapter) are a separate future step that builds on this integrity layer.

**Rule 1 (id-immutable) protects across the whole draft, not just per-mutation.** Comparing the proposed state to PUBLISHED means a `delete_node(X)` + `create_node(X's content under a new id)` sequence on the same draft is caught as a disguised rename — even though the individual mutations only remove or only add. A legitimate replace (create a node with substantively different content) still passes.

**End-to-end example — add a new chapter+lesson pair:**

```
curator: create_node(kind="chapter", properties={title:"Nouveau chapitre", raw:{chapitreNum:42, chapitreTitre:"…"}})
         → dry-run: diff (+1 node), confirmationToken, mintedNodeId="uuid-A"
curator: create_node(..., confirm:true, confirmationToken:..., mintedNodeId="uuid-A") → applied to draft
curator: create_node(kind="lesson", properties={text:"Une nouvelle leçon", raw:{osTexte:"…"}})
         → dry-run + confirm → mintedNodeId="uuid-B" on draft
curator: link_nodes(edgeType="hasChild", fromId="uuid-A", toId="uuid-B") → dry-run + confirm → edge on draft
approver: diff_draft() → sees +2 nodes, +1 edge across the whole draft
approver: publish_draft() → dry-run + confirm → all three changes go live atomically
```

**Two ways to delete a connected node:**

```
# (a) manual detach, then delete — full control, one edge at a time
curator: delete_node(nodeId="…") → BLOCKED: "still has N incident edge(s): <ids>. …either unlink first, or pass force:true."
curator: unlink_nodes(edgeId=…) → dry-run + confirm  (repeat per incident edge)
curator: delete_node(nodeId="…") → dry-run + confirm → node removed on draft

# (b) explicit force cascade — one atomic mutation, whole subtree
curator: delete_node(nodeId="…chapter…", force:true)
         → dry-run: diff shows the chapter + all its lessons/components/tasks + every incident edge that will be removed
curator: delete_node(nodeId="…chapter…", force:true, confirm:true, confirmationToken:…)
         → the whole subtree is gone from the draft, atomically; the result is re-checked and clean
```

### Curriculum recipes (composite mutations) — the ergonomic layer

The raw verbs above are correct but tedious for real curriculum restructuring: adding a chapter with three lessons is one `create_node` + one `create_node` per lesson + one `link_nodes` per lesson — six confirmations, six chances to leave a half-built draft. **Recipes** collapse each such intent into a **single composite mutation**: one dry-run → one whole-composite diff (every added/removed/changed node and edge together) → one confirmation token → one atomic draft write → one audit event. They are the ergonomic layer over the primitives, **made safe by the same referential-integrity floor** — the whole result is validated by Rule 1/Rule 2 before the token is issued, so an invalid composite (e.g. a move that would orphan a lesson) is rejected **as a whole**; nothing partial lands. Recipes reuse the primitives' own `apply` functions internally — they are server-side composites, never Claude hand-sequencing separate tool calls.

The recipes are **four GENERIC, subject-agnostic verbs** (`kg-recipes/`). They speak **pure canonical LC** — no chapter/domaine/week vocabulary and **no per-subject `RecipeProfile`** — and are available on **every** subject (validity is structural, not a per-subject allowlist).

- **`add_node`** (the create-one-node verb) — create one node with an LC `label` and attach it under `parentId` via the canonical containment edge (`hasPart` for content — LessonGrouping/Lesson/Activity/Material; `hasChild` for standards; override with `via`), at a `position` (append default). Optionally `alignTo` a `StandardsFrameworkItem` (`hasEducationalAlignment`). `properties` is a free bag of extra canonical LC props written under `raw.*` (`content`, `materialType`, `studentGroupingType`, `timeRequired`, `educationalUse`, `groupName`…). The node's **LC identity is derived from the graph**: labels, `normalizedType`, role, and its raw ordinal path(s) are copied from an existing node of the same label — or canonical LC defaults when none exists yet (e.g. reading's first Activity). A nonexistent parent or a non-SFI `alignTo` is BLOCKED. **Exposed as the batched tool `add_nodes`** (one node or many in one atomic edit) — which **retired the per-label typed adds** (`add_lesson`, `add_lesson_grouping`, `add_activity`, `add_material`, …); each kind's `properties` vocabulary is catalogued in `KIND_PROPERTIES` (mirrored by `get_capabilities` under `editable.batch.kindProperties`).
- **`move_node(nodeId, toParentId, [via, position])`** — re-parent along one containment axis: detach the current parent edge, attach `toParentId`, set position. A node's **second axis** (e.g. a maths lesson also scheduled under a week via `hasChild`) is left intact. Replaces `move_lesson`.
- **`edit_node(nodeId, [content, position, title, title_en])`** — edit a node's fields in place, one atomic draft edit. `content` replaces the load-bearing content (canonical LC `Material.content`); `position` sets the ordinal among siblings (membership is the containment edge, so this **never cascades**); `title`/`title_en` set the display name (normalized to the node's `title` vs `text` field by its label, + `raw.description`). Pass at least one. It **consolidated `reposition` + `set_content`** (exposed as the `edit_node` tool) and added title editing (which had no verb after `upsert_property` was removed). Edit in place — never delete + re-add (that cascades the subtree, drops edges, and mints a new id).

`add_nodes` mints each node's id server-side and surfaces them on the dry-run (`mintedNodeIds`, in item order); pass them back on confirm.

**The block-vs-warn behaviour is inherited from #13, not re-invented.** A composite that would leave the graph referentially broken (a dangling edge, a disguised rename) is BLOCKED; a composite that leaves it valid-but-incomplete (a grouping left without a bilan) WARNS on the dry-run and `diff_draft` but never blocks. The approver decides.

**Positions are the single ordinal concept.** A node's `position` lives in the normalized top-level `order` mirrored into `raw` at the source's own path(s) (CI maths carries **both** `raw.position` and `raw.metadata.order`; reading uses `raw.position`). `add_node` writes every path the copied example uses, and `move_node`/`edit_node` write every path the node itself uses — so a created, moved, or repositioned node round-trips faithfully with no per-subject alias config.

```text
# add a grouping, then a lesson aligned to an existing expectation
curator: add_node(parentId="<framework>", label="LessonGrouping", title="Nombres décimaux", properties={groupName:"Chapitre"})
         → dry-run: diff shows 1 LessonGrouping added; token + mintedNodeId
curator: add_node(..., confirm:true, confirmationToken:…, mintedNodeId:…)
curator: add_node(parentId="<grouping>", label="Lesson", title="Découverte", alignTo="<expectation>")
         → dry-run: diff shows 1 Lesson + a hasPart edge (grouping→lesson) + a hasEducationalAlignment edge (lesson→expectation); token + mintedNodeId
curator: add_node(..., confirm:true, confirmationToken:…, mintedNodeId:…)
         → the composite lands on the draft atomically; one audit "apply" event each

# edit a grouping's position → only that node changes; children follow via the edge
curator: edit_node(nodeId="<grouping>", position=26) → dry-run: diff shows ONLY the grouping as CHANGED
curator: edit_node(..., confirm:true, confirmationToken:…) → applied atomically; children stay attached via hasPart
```

### `get_capabilities` — a truthful mirror of "what can I do?"

`get_capabilities` is a read-only tool that reports, for the currently-authenticated caller and the active grade/subject:

- **actor** — verified id, whether the caller is known, and their role (`curator` / `approver` / `null`), all from the JWT — never client-supplied.
- **actions** — which of `canReadGenerate` / `canReadDraft` / `canEditDraft` / `canDiscardDraft` / `canPublish` / `canReadAudit` are allowed. **Each value is computed by calling `authorize()` — the same function every write tool actually uses.** No role-mapping logic lives in the tool itself.
- **audit** — advertises `read_audit` (approver-only, read-only); `available` mirrors the same `authorize(actor, "readAudit", ns)` gate the tool enforces, so it cannot drift.
- **draft** — whether a draft is open on this namespace, and (if so) who created it and when (from the audit log). Useful for a second curator to see they'd be editing someone else's draft.
- **editable** — the current edit surface: `keysByNodeKind` is the active adapter's `wordingAliases` live object; `safePaths` is the central `UPSERT_PROPERTY_SAFE_PATHS` allowlist; `structural.verbs` lists the four raw primitives with `cascade: "explicit-force-only"` (so callers know `delete_node` needs `force:true` to cascade and refuses otherwise); `recipes` is a **mirror of the generic `RECIPES` registry** — each verb's name, summary, and params (currently `edit_node`; node creation is `add_nodes`), rendered straight from the code so what Claude discovers can't drift from what's built, and `available: true` on every subject (the verbs are generic); `coverageWarnings.enabled` says whether the active subject emits completeness warnings, with a note that they never block. All fields are read from source, not retyped.
- **rules** — the structural rules (id-immutable, no-orphan) as descriptions imported from `validate.ts`, plus the two-phase confirm expectation.

**Why it exists.** So Claude can tell a curator accurately what they can and cannot do BEFORE trying — instead of discovering limits by hitting errors, or inferring from tool names. Available to any caller: an unknown user gets a truthful "read/generate only" response, not a 401.

**Guarantee.** A mirror-property test asserts, for every role and every gated action, that `get_capabilities.actions.canX === authorize(actor, X, ns).ok`. If those ever disagree, one of them is a copy that drifted — the test catches it. This tool cannot lie about permissions by design.

**Concurrency of edits is an open decision for the next step.** With no write tools this step doesn't exercise contention. When writes land (#5/#11), the team will need to pick a strategy — optimistic version counter on each edit, an explicit "who holds the draft" lock, or per-user drafts. The two-slot foundation supports any of them; nothing about it locks in the choice.

**Re-seeding after a publish.** The seed always writes into slot `a` and only initialises the pointer the first time (`ensurePointer` is a no-op if one already exists). Once a curator publishes (which flips `publishedSlot` to `b`), a re-seed writes to `a` — which is now a stale side copy, not the live published data. The seed logs a WARNING when it detects this; reconciling it deliberately (typically by making the fresh bundle the next draft rather than the next seed) is the operator's call.

### `read_audit` — reviewing the trail (approver-only, read-only)

`read_audit` is a filtered, paginated, **read-only** view over the append-only audit log — the supported way to review the trail through the MCP, replacing the manual Firestore-console check. It completes the #7 (append-only log) / #8 (roles) foundation: the log is now actually *reviewable* by the accountability tier. It is deliberately a **reader, not analytics** — query → page of records; no dashboards, no anomaly detection, no aggregations or exports.

- **Approver-only, read-only, namespace-scoped.** Gated through the same `authorize()` chokepoint that gates publish (a new `readAudit` action, allowed only for `approver`). A curator or no-role/unknown caller is **blocked** — and the blocked read is itself audited (a `blocked` record whose `reason` starts `"unauthorized: …"`). Scope is the caller's current `set_context` namespace, resolved from the active adapter exactly like every other tool: **there is no namespace argument.** To review another namespace, `set_context` to it first.
- **Filters** (all optional, AND-combined): `actor` (actor id), `action` (event type — `apply` / `createDraft` / `publish` / `discard` / `blocked` / `preview` / `read`), `outcome` (`applied` vs `blocked`), `nodeId` (entries whose `apply` diff touches that node — the node itself or an incident edge), and `since` / `until` (inclusive ISO-8601).
- **Pagination & ordering.** Newest-first, page size `limit` (default 25, max 100), with an opaque cursor — pass the returned `nextCursor` back to walk the log with no overlap. (Under the hood the reader reuses `listAudit` — coarse-filtered server-side, paginated in the reader; fine at current single-namespace scale. A true Firestore `orderBy+startAfter` cursor is the clean upgrade if volume grows.)
- **Modes.** `summary` (default) returns compact rows — `auditId`, `ts`, `actor`, `action`, `outcome`, `namespace`, a one-line `target` descriptor, and `selfAuthored` on publishes — with **no** before/after. `detail` returns the full record including the before/after `diff`; passing an `auditId` fetches that one record in detail.
- **The read-event (who reviewed history).** Each successful call appends **exactly one** lightweight `read` audit event — `actor` + a compact `readQuery` + `ts` + `readCount` — **never** a before/after or snapshot. It is appended *after* the query returns, so it triggers no further read: growth is linear, never recursive, and carries no state to bloat with. Read-events are first-class records (visible and filterable via `action: "read"`), so "who reviewed the trail, with what query" stays answerable.
- **Strictly read-only.** It reuses only the store's `listAudit` + `appendAudit` surface — there is no update/delete on the interface — so it structurally **cannot** create (beyond the read-event), edit, delete, redact, or reorder any audit record. The append-only guarantee of #7 is preserved absolutely; a test proves the log is byte-for-byte unaffected by any number of reads (aside from the read-events they append).

Advertised in `get_capabilities` under `actions.canReadAudit` and the `audit` block, both mirroring the same gate the tool enforces.

### Parity check

`get_generation_context`, `walk_graph`, and `namespace_stats` must return structurally identical output for every grade/subject against both backends. Run:

```bash
npm run parity:kg-store                  # offline: memory store seeded from bundle
npm run parity:kg-store -- --live        # against live Firestore (needs a prior seed)
npm test                                 # includes src/kg-store/__tests__/parity.test.ts
```

Diffs fail the harness. The oracle deep-equals the parsed reads — key ordering doesn't cause false diffs, but the response shape itself must not change. A secondary manual check (regenerating a manual and a lessons deliverable with the flag flipped and confirming the pre-LLM generation context is identical) is documented in the roadmap; the LLM output itself is not byte-stable and is not the parity oracle.
