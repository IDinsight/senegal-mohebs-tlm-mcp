# Technical reference — senegal-mohebs-tlm-server

The deep operational + design reference. The [README](../README.md) is the short overview; this doc holds the KG store & curator loop, the explorer, generation/storage, and deployment. For the current architecture summary see [CLAUDE.md](../CLAUDE.md).

> **Note (maths↔reading convergence).** Both subjects now share the `{ nodes, relationships }` envelope + LC metadata scheme and parse through one generic `curriculum/parse-graph.ts`. Chapter↔lesson membership is the `hasChild` **edge** — the old denormalized `chapitreNum` join is gone, so move/split rewire the edge and renumber changes only the chapter's own number (no cascade, no drift). The sections below have been updated where it matters, but if any deeper design prose still says "chapitreNum join" / "regime-B", read it as historical — CLAUDE.md is the current source of truth.

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

These lifecycle functions live on the internal `KgNodeStore` interface — **no user-facing MCP tools are exposed yet**. Tool-facing wrappers for `create_draft` / `publish_draft` / `discard_draft` (and a `diff_draft`) land in a later step (#10). Preview generation against a draft (#15) will use the draft-read path that this step lays down but doesn't expose.

### Graph-mutation framework (draft-only apply)

Sits on top of the draft/published split. A **graph mutation** is a pure function over `{nodes, edges}` — e.g. "set property X on node Y", "delete node Z". The framework in [`src/kg-store/mutations.ts`](src/kg-store/mutations.ts) gives every new mutation the same two-phase confirm plumbing for free:

- **preview** (no `confirm`) → runs `validate` (empty seam today; #6 fills it), computes a per-mutation `diff` keyed by stable id, and returns the shared confirmation envelope extended with `diff`, `warnings`, and a `confirmationToken`. Changes NO state.
- **confirm** (with the `confirmationToken`) → verifies the token matches the mutation + args + base-version + is unused, lazily creates a draft if none exists (byte-for-byte from published), then applies the mutation to the **draft slot only** via `writeSlot`. Published is unaffected — publish is a separate step (#10).

The framework uses only stable ids (LC IRIs for nodes; deterministic `edgeId(type, from, to)` for edges) — friendly properties like `chapitreNum` live in `properties.raw` and are NEVER used as identity. A stale token (base moved between preview and confirm) or a replayed token is rejected cleanly with no partial apply. See [`docs/kg-mutations-framework.md`](docs/kg-mutations-framework.md) for the full design note, decisions, and the mutation interface.

**No user-facing graph edit tool ships in this step.** The framework has exactly one test-only mutation, wired inside `mutations.test.ts` — real edit tools (`upsert_property` / `create_node` / `delete_node` / `link_nodes`) land in #11/#12.

### Write-safety rules (structural only)

Every graph mutation goes through two shared structural rules in [`src/kg-store/validate.ts`](src/kg-store/validate.ts) before the human review gate. Errors from either rule **block confirmation** — no token is issued, so there's nothing to replay.

- **Rule 1 (id-immutable).** A node's id is the LC IRI verbatim (or, for a `create_node`-minted node, a randomUUID); an edge's id is `edgeId(type, from, to)`. Every reference in the graph points at these ids, so a silent rename would orphan everything the reviewer can't easily see in a diff. The rule compares the proposed state to the **currently-published** graph (not just the pre-mutation state) — a removed-since-publish node and an added-since-publish node with matching content are treated as a rename attempt and rejected, whether the pair occurs inside one mutation OR across a delete+create sequence on the same open draft. Legitimate delete-then-create (genuinely different content) passes.
- **Rule 2 (no-orphan).** After the edit, every edge's `from` and `to` must resolve to a node in the graph. This subsumes "no removed node has surviving edges targeting it." Load-bearing since #12: a plain `delete_node` is REFUSED if any incident edge survives. A `force:true` delete cascades the dependent subtree and all incident edges in one atomic mutation, and Rule 2 re-runs on the *result* to prove the cascade itself left nothing dangling — so even the forced path can't produce a broken graph.

**Denylist = just the `id` key** (on nodes and edges). References in this graph are edges-only at the storage level — `properties.raw` carries content and match-keys, never a stored id pointing at another node — so there are no reference-bearing properties to protect. If a future subject introduces one, the denylist extends by a single entry.

**We don't check content.** Whether a title reads well, whether a number is sensible, whether wording matches the KG's own — that's what the draft → review → publish gate is for. A reviewer sees the whole diff and approves it. The machine only guards the two errors a reviewer can't eyeball; anything else would drift toward the schema we deliberately don't build.

A mutation may still add its own `validate(base, after, args)` on top of the shared rules for anything only it can decide; both layers run and their errors compose.

### Referential integrity — block vs warn

The integrity layer draws one line, applied consistently:

- **BLOCK (error, no token)** — anything that would leave the graph **referentially broken**: a dangling edge, a reference pointing at a node that won't exist post-edit, a disguised rename (Rule 1). This is corruption a reviewer can't see in a diff, so the machine refuses it outright. These are the shared, subject-agnostic rules in [`validate.ts`](src/kg-store/validate.ts).
- **WARN (informational, still confirmable)** — structural **incompleteness that is valid-but-suspect**: a chapter with no lessons, a chapter missing its bilan, a lesson linked to more than one *chapter* (its week parent is a separate axis and expected). A curator may legitimately be mid-edit, so these never block; the approver decides. Warnings ride the dry-run response and `diff_draft`, and are recorded on the publish audit (`warningsAtPublish`) for traceability — but publish proceeds.
- **CASCADE only on explicit `force`** — never silent, and the dry-run diff shows the full set that will vanish (see `delete_node` below).

**Where the two live.** The BLOCK rules are universal — they know only nodes and edges, never "chapter" or "bilan" — so they sit in the shared `kg-store` layer. The WARN rules are *unit-shaped* — they depend on what a unit IS for a given subject — so they live behind an optional adapter hook, `SubjectAdapter.coverageWarnings(graph)`. Subject-neutral shapes (empty container, a child with two parents) are reusable helpers in [`curriculum/coverage.ts`](src/curriculum/coverage.ts) that any adapter calls with its own kind names; genuinely subject-specific rules (the CI maths bilan; a lesson with more than one *chapter* parent) are written in the CI maths adapter. CE1 reading uses the generic helpers only. Nothing subject-specific leaks into the shared layer.

**The reference regime.** Every cross-entity link in the store is an **id-based edge** (`hasChild`, `buildsTowards`) — Rule 2 covers them all. Chapter↔lesson membership is the `hasChild` edge, so renumbering a chapter or moving a lesson is a pure edge/attribute operation with nothing to keep in sync. (CI maths lessons carry a second `hasChild` axis — a `week → OS` schedule edge alongside the `chapter → OS` content edge — so a lesson has two parents by design; the multi-parent coverage rule is scoped to *chapter* parents.)

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

**Authorization derives ONLY from the verified Supabase identity.** The role is delivered as an `app_role` claim on the Supabase JWT — same trust channel as `sub` / `email`. No tool argument, header, or client-settable field can influence the decision. See [`src/authz.ts`](src/authz.ts) and [`src/actor.ts`](src/actor.ts).

**Where roles live.** The `public.user_roles` table in Supabase is the source of truth. A **Custom Access Token Hook** (Supabase → Authentication → Hooks) reads it and injects `app_role` into the JWT at token-mint time — zero extra I/O at request time; the MCP just reads the already-verified claim. Setup SQL: [`scripts/supabase-user-roles.sql`](scripts/supabase-user-roles.sql).

**Bootstrap.** Run the SQL script once via the Supabase dashboard SQL editor, then enable the hook in Authentication → Hooks → "Customize Access Token (JWT) Claims" pointing at `public.custom_access_token_hook`. Grant the first approver with `insert into public.user_roles (user_id, role) values ('<uid>', 'approver');` in the SQL editor. Further grants happen the same way. **The MCP server exposes no role-management tool** — self-escalation surface is zero.

**Separation of duties.** By default an approver may publish a draft they authored edits in (`TLM_ALLOW_SELF_APPROVE` env, default `"1"`). To require a second reviewer, set `TLM_ALLOW_SELF_APPROVE=0` — publish is then denied if any promoted `apply` record was authored by the same approver. **Regardless of the flag**, every `publish` audit record carries `selfAuthored: boolean` so a reviewer can spot self-approval even when permitted.

**Enforcement point.** Role checks live in the MCP server at the Firestore write chokepoint (`runGraphMutation`, `publishDraft`, `discardDraft` in [`src/kg-store/mutations.ts`](src/kg-store/mutations.ts)). Supabase Row Level Security guards direct Postgres access to `user_roles`, but the graph write itself lands in Firestore — RLS doesn't cover that, so the MCP is where enforcement has to be.

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

- **`add_lesson(chapterId, text, [text_en, order, isBilan])`** — create a lesson and link it (`hasChild`) to an existing chapter, in one edit — chapter membership IS the edge. Additive: linking to a nonexistent chapter is BLOCKED.
- **`add_chapter(number, title, [title_en, lessons[]])`** — create a chapter (title + number at birth) with optional seed lessons, as one composite. `number` must be **free** — append after the last chapter or fill a numbering gap; a colliding number is rejected (inserting between chapters and shifting the rest is `renumber`'s job, not this additive path).
- **`move_lesson(lessonId, toChapterId, [position])`** — rehome a lesson: unlink the old `hasChild` edge and link the new one, atomically. Membership is the edge, so the lesson keeps its own number. Appends to the target by default.
- **`split_chapter(chapterId, atLessonId, [newTitle, newTitle_en, newNumber])`** — create a new chapter and move the tail lessons (from `atLessonId` onward) into it. The new chapter is **appended at the next free number by default** (no existing chapter is shifted); pass a free `newNumber` to place it in a gap.
- **`renumber(chapterId, newNumber)`** — change a chapter's number. Lessons follow via the `hasChild` edge — no cascade. The target number must be **free** (renumber MOVES a chapter to an unoccupied number; insert-with-shift and swap are rejected).

Recipes that create nodes mint the id(s) server-side and surface them on the dry-run (`mintedLessonId` / `mintedChapterId` / `mintedLessonIds`, exactly like `create_node`'s `mintedNodeId`); pass them back on confirm. Recipes are available only for a subject whose adapter declares a `recipeProfile` (CI maths does; CE1 reading does not) — otherwise the tool returns a clear "not available" message rather than guessing.

**Structural-property editing (the foundation move/split/renumber needed).** These recipes must change STRUCTURAL properties of *existing* nodes — a chapter's number, a lesson's position — which `upsert_property` deliberately refuses (it is wording-only). That path is a curated set of numeric keys (`order`, `raw.metadata.order`) declared per node kind in the adapter's `structuralAliases` and validated against a central `STRUCTURAL_EDIT_SAFE_PATHS` allowlist (the exact analogue of `UPSERT_PROPERTY_SAFE_PATHS`). By design there is **no raw structural-edit tool** — these keys are editable only *through* the recipes.

**The block-vs-warn behaviour is inherited from #13, not re-invented.** A composite that would leave the graph referentially broken (a dangling edge, a disguised rename) is BLOCKED; a composite that leaves it valid-but-incomplete (a split that leaves a chapter without a bilan) WARNS on the dry-run and `diff_draft` but never blocks. The approver decides.

**How `renumber` behaves — edge-based membership.** Chapter↔lesson membership is a single id-based `hasChild` edge (the Rule-2-guarded backbone) — there is no denormalized number join. So `renumber` changes only the chapter's own number; the lessons stay attached by the edge and are untouched. `move_lesson` / `split_chapter` rewire the `hasChild` edge; they too need no number rewrite. (Historically CI maths joined by a denormalized `raw.chapitreNum`, which forced a cross-lesson cascade and a drift warning — that join was removed in the maths↔reading convergence.)

```text
# add a chapter with two lessons — ONE composite, ONE confirm
curator: add_chapter(number=26, title="Nombres décimaux", lessons=[{text:"Découverte"},{text:"Bilan", isBilan:true}])
         → dry-run: diff shows 1 chapter + 2 lessons + 2 hasChild edges added; token + mintedChapterId + mintedLessonIds
curator: add_chapter(..., confirm:true, confirmationToken:…, mintedChapterId:…, mintedLessonIds:[…])
         → all five nodes/edges land on the draft atomically; one audit "apply" event

# renumber chapter 3 → 26 — only the chapter's number changes; lessons follow via the edge
curator: renumber(chapterId="…", newNumber=26) → dry-run: diff shows ONLY the chapter as CHANGED
curator: renumber(..., confirm:true, confirmationToken:…) → applied atomically; lessons stay attached via hasChild
```

### `get_capabilities` — a truthful mirror of "what can I do?"

`get_capabilities` is a read-only tool that reports, for the currently-authenticated caller and the active grade/subject:

- **actor** — verified id, whether the caller is known, and their role (`curator` / `approver` / `null`), all from the JWT — never client-supplied.
- **actions** — which of `canReadGenerate` / `canReadDraft` / `canEditDraft` / `canDiscardDraft` / `canPublish` / `canReadAudit` are allowed. **Each value is computed by calling `authorize()` — the same function every write tool actually uses.** No role-mapping logic lives in the tool itself.
- **audit** — advertises `read_audit` (approver-only, read-only); `available` mirrors the same `authorize(actor, "readAudit", ns)` gate the tool enforces, so it cannot drift.
- **draft** — whether a draft is open on this namespace, and (if so) who created it and when (from the audit log). Useful for a second curator to see they'd be editing someone else's draft.
- **editable** — the current edit surface: `keysByNodeKind` is the active adapter's `wordingAliases` live object; `safePaths` is the central `UPSERT_PROPERTY_SAFE_PATHS` allowlist; `structural.verbs` lists the four raw primitives with `cascade: "explicit-force-only"` (so callers know `delete_node` needs `force:true` to cascade and refuses otherwise); `structuralKeys` mirrors the adapter's `structuralAliases` + the `STRUCTURAL_EDIT_SAFE_PATHS` allowlist (the numeric keys editable only through recipes); `recipes` is a **mirror of the `RECIPES` registry** — each recipe's name, params, and its `renumberBearing` flag, rendered straight from the code so what Claude discovers can't drift from what's built; `coverageWarnings.enabled` says whether the active subject emits completeness warnings, with a note that they never block. All fields are read from source, not retyped.
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

`get_generation_context`, `get_curriculum`, and `list_units` must return structurally identical output for every grade/subject and every unit against both backends. Run:

```bash
npm run parity:kg-store                  # offline: memory store seeded from bundle
npm run parity:kg-store -- --live        # against live Firestore (needs a prior seed)
npm test                                 # includes src/kg-store/parity.test.ts
```

Diffs fail the harness. The oracle deep-equals the parsed reads — key ordering doesn't cause false diffs, but the response shape itself must not change. A secondary manual check (regenerating a manual and a lessons deliverable with the flag flipped and confirming the pre-LLM generation context is identical) is documented in the roadmap; the LLM output itself is not byte-stable and is not the parity oracle.

## KG explorer (read-only live viewer)

A hosted static page that lets a CI maths/CE1 reading expert pick a knowledge graph and explore it
**live** — sourced from Firestore's PUBLISHED slot, not a baked snapshot. It is **read-only**:
it never writes, never sees drafts, and does not touch the MCP tools or their auth. Editing
stays in the MCP curator tools. See `docs/kg-explorer-findings.md` for the design rationale and
the data-scope finding.

Two pieces: a read-only **export endpoint** (companion routes on the same Cloud Run service,
`src/kg-export.ts` + routes in `src/http.ts`) and the **hosted explorer** (`hosting/public/index.html`,
a fork of the original single-file explorer — same look and interactions, live data).

### Endpoint contract

All routes are additive; the MCP `/mcp` surface is unchanged. Reads resolve to the pointer's
`publishedSlot` only (a curator's draft never leaks here until they publish).

- `GET /kg/config` — **public**. `{ supabaseUrl, supabaseAnonKey, authRequired }` so the static
  page can drive its own Supabase login without baking deployment config into the HTML.
- `GET /kg/namespaces` — **auth-gated**. `{ namespaces: [{ ns, grade, subject, label:{fr,en} }] }`.
  Lists every installed context that has a published pointer, so a newly seeded KG appears in the
  selector automatically.
- `GET /kg?ns=<namespace>` — **auth-gated**. The published **display-JSON** for one namespace:

  ```jsonc
  {
    "nodes": [ { "id", "label", "kind", "nt", "st","st_en", "code", "desc","desc_en",
                 "dom","pal","sem","chapN","chapT", "src","ref","statut", "srcKey", ... } ],
    "edges": [ { "s", "t", "r", "o" } ],           // r ∈ {hasChild, buildsTowards}; o = sibling order
    "meta": {
      "ns", "label", "publishedSlot", "generatedAt",
      "counts": { "nodes", "edges", "byKind" },
      "sources": ["RECE","Rwanda P1", ...],        // distinct srcKeys present → source-filter chips
      "viewConfig": { "views": [ { "id","label","shape","params" } ] }
    }
  }
  ```

**Auth** (decision: Supabase login). When `SUPABASE_URL` is set, `/kg/namespaces` and `/kg`
require a valid Supabase Bearer JWT — the same trust channel as `/mcp`. The static page runs a
small `supabase-js` email/password login (mirroring `/oauth/consent`) and sends the token. In
`ALLOW_UNAUTHENTICATED=1` (local only) the routes are open.

**CORS.** Allow-listed to the Firebase Hosting origin(s); override with `KG_ALLOWED_ORIGINS`
(comma-separated). `localhost`/`127.0.0.1` are always allowed for local dev. The deployed page
does not actually need CORS — Firebase Hosting **rewrites** `/kg/**` → the Cloud Run service
(`firebase.json`), so the browser calls same-origin and Hosting proxies to Cloud Run (the JWT
passes through). CORS covers direct/local access.

### The raw-LC → display transform

The store holds a NORMALIZED graph (generic `{type, properties:{code,title,text,order,isAssessment,raw}}`)
in the converged snake_case LC metadata scheme. `toDisplayNode` maps each stored node to the
explorer's display schema:

| display field | source | display field | source |
|---|---|---|---|
| `label` | derived from `kind` | `dom` | domaine node's name, **propagated** to its content-axis descendants server-side |
| `kind` | store `type` (`domaine`/`chapter`/`week`/`lesson`/`standard`/`component`/`task`) | `pal` | `raw.palier` / `raw.metadata.palier` (weeks) |
| `code` | `properties.code` (`raw.statement_code`) | `ord` | `properties.order` / `raw.metadata.order` (domaine: canonical index) |
| `desc`/`desc_en` | `properties.text`/`title` · `raw.description`/`raw.os_texte` · `_en` from `raw.metadata.en.*` | `os`/`os_en` | `raw.os_texte` / `raw.metadata.en.os_texte` |
| `st`/`st_en` | `raw.statement_type` (category) / `raw.metadata.en.statement_type` | `src`/`ref`/`statut` | `raw.source`/`reference`/`statut` |
| `nt` | `raw.normalized_statement_type` / `raw.content_type` | `srcKey` | `raw.source_key` |
| `ex`/`ex_en`, `apt`, `comm` | `raw.examples` / `raw.aptitude_ci` / `raw.commentaire_progression` (`_en` under `raw.metadata.en`) | `strand`,`genre` | `raw.statement_type` (reading standards only), `raw.metadata.genre` (weeks) |

Edges are the stored `hasChild` + `buildsTowards` as `{s,t,r,o}`. Domaine / Semaine / Chapitre are now
**real nodes** joined by `hasChild` edges (two axes: `domaine → chapter → OS` content, `week → OS`
schedule) — no client-side grouping synthesis; the views walk the actual node hierarchy.

### Data-driven views (`meta.viewConfig`)

The frontend is generic and renders whatever views `meta.viewConfig` declares — no per-namespace
`if` anywhere. Two view **shapes**:

- `grouped-spine` — anchors on `anchorKind` nodes (optionally bucketed by `groupBy` props; empty
  `groupBy` = the anchors ARE the roots), then walks the `expandEdge` (`hasChild`) subtree.
- `node-type` — the generic floor, works for ANY namespace: each node type → its nodes → their
  outgoing relations.

Both subjects declare the same three tabs: **thematic**, **planification**, **generic**.

- **Thematic** — by the subject's thematic categories. Maths anchors on the real `domaine` node and
  walks `hasChild` (Domaine → Chapitre → OS → composant → tâche). Reading has no seeded grouping nodes,
  so it groups standards by their language-tool **strand** (`groupBy: [strand]`, `order` = the six
  outils de langue) → the standards → their components.
- **Planification** — `Palier → Semaine → …`: anchor `week`, `groupBy: [palier]`, expand `hasChild`.
  Reading weeks carry their palier; maths weeks borrow it from a scheduled lesson (derived in
  `exportNamespace`, see below).
- **Generic** — `node-type`.

`buildViewConfig` picks the thematic anchor by which kinds are present (`domaine` → maths hierarchy;
else `standard` → reading strand grouping). The backend is covered by `src/kg-export.test.ts`; the
static frontend (`hosting/public/index.html`) is data-driven and adapts — **re-verify in-browser after
`gcloud run deploy` (the /kg endpoint) + `firebase deploy --only hosting`.**

**Explorer post-processing** (`exportNamespace`, display-only — never touches the store): (1) domaine
**colour** is propagated down the content axis so a whole subtree shares its domaine's colour; (2) a
maths **week palier** is derived from its scheduled lessons; (3) a **navigable-spine filter** keeps
only nodes reachable from a root (`week`/`domaine`) via `hasChild`. Reading's parse is now
spine-scoped (its `postParse` keeps only the six language-tool week-standards + their components), so
this filter is a no-op there; it still trims maths's few borrowed-framework component/task leftovers
(pre-existing — the maths parse maps every `LearningComponent`/`Curriculum` node). A safety net that
de-noises the explorer without a re-seed.

### Adding a new KG

Seed it into Firestore (see [Seed](#seed)). It then appears in the selector automatically. If its
data has the CI maths-shaped fields it gets the rich views; otherwise it renders via the generic
`node-type` view — no frontend change. To give a differently-shaped KG its own rich views, extend
`buildViewConfig` in `src/kg-export.ts` with a new detection + a new view `shape` in the frontend.

### Data-scope finding (what's in the graph)

**The store now holds the FULL Learning-Commons graph** (superseding the earlier spine-only
design). The seed pipeline still runs each adapter's `parse()`, but `parseGraph` echoes the raw
graph onto the model (`CurriculumModel.rawGraph`), and `serializeModel` persists EVERY raw node and
EVERY raw edge verbatim (`ci/maths`: 397 nodes / 773 edges; `ce1/reading`: 1401 / 1362):

- **Spine nodes** (the ones `parse()` keeps — `ci/maths` domaine→chapter→lesson→component→task,
  `ce1/reading` week→standard→component) carry `spine: true` plus their normalized fields.
- **Non-spine nodes** (the RECE framework, the six derived-source family branches, grouping
  wrappers) carry `spine: false` and only `properties.raw` — kept purely for faithful re-export.
- **Edges** keep their real LC type — `hasChild`, `supports`, `relatesTo`, `buildsTowards` — with a
  `seq` recording raw order. `supports` is no longer folded into `hasChild`.

**Reads are unchanged.** Hydration rebuilds the raw envelope (`toRawEnvelope`) and re-runs the same
`adapter.parse`, so the read model is the identical spine — guarded byte-for-byte by
`parity:kg-store`. Non-spine nodes are dropped by `parse` at read time exactly as in a bundle read.

**Re-export.** Because the store IS the raw graph, `toRawEnvelope(storedNodes, storedEdges)`
reproduces the source `knowledge_graph.json` (guarded by `src/curriculum/faithful-reexport.test.ts`)
— the store can replace the bundle. The explorer surfaces the whole graph: spine categories plus a
neutral `framework` legend bucket for non-spine nodes and the `supports`/`relatesTo` cross-links.
See `docs/kg-explorer-findings.md` §1 for the original spine-only analysis (superseded).

### Deploy the explorer

```bash
firebase deploy --only hosting --project senegal-ci-maths    # → https://senegal-ci-maths.web.app
```

`firebase.json` rewrites `/kg/**` to the `senegal-mohebs-tlm` Cloud Run service (region
`europe-west1`). Local dev: run the server (`node dist/http.js` with `ALLOW_UNAUTHENTICATED=1`)
and open the page with `?api=http://localhost:<port>` so it hits the local endpoint directly.

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
Document identity is `scope:deliverable` (e.g. `5:manual`, `5:lessons`) **within a grade/subject**; the scope is the first integer in the subfolder name, and the active subject's adapter classifies the filename into a deliverable (for CI maths: a file named "Fiches de leçons …" is the lesson-sheets doc, anything else is the manual).

## The generation flow (cross-host, no shared disk)

0. `set_context(grade, subject)` — pick what you're working on. `get_context` lists the installed pairs and the current selection.
1. `get_generation_context(unit, deliverable)` — curriculum slice, established characters, terminology guidance, coverage, and (for the teacher guide) the manual to build on. `unit` is the scope value (for CI maths, the chapter number) and `deliverable` is a deliverable key (`manual`/`lessons`). For example-domain variety it returns `exampleDomains: { suggested, avoidNearby }`: `suggested` is a fresh object family to use, and `avoidNearby` maps each *nearby* chapter number (within ±`TLM_DOMAIN_NEIGHBORHOOD_K`) to the domains it used — so adjacent chapters don't repeat the same family. This is a bounded window, not the whole book; use `domain_usage` for the full log.
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

## Preview generation (draft-resolved, isolated from published)

An expert who has staged a draft edit can generate a **preview** of the teaching material that edit would produce — reading the **draft** instead of published — **without touching published, the canonical documents bucket, or the canonical generation history.** This closes the editing loop: the dry-run (per-mutation diff) and `diff_draft` show the **graph change**; preview shows the **result** — the material that change yields.

- **`preview_generation(unit, deliverable)`** — the draft-resolved analog of `get_generation_context`. It resolves the unit's curriculum from the **draft slot** (the same slot `diff_draft` reads) via the store-bridge and the subject adapter, then runs the adapter's *own* `buildGenerationContext` on that model. Same inputs and same output shape as the published path, but the returned context is **tagged `preview`** and carries the label *"PREVIEW — generated from an unpublished draft, not a published deliverable."* Read-only on the draft — it does **not** mutate the graph.
- **`create_preview_upload_url(relPath)`** — the preview **output** path. Signs short-lived (10 min) write + read URLs for a throwaway `.docx` under the **segregated `previews/` prefix**. Never the canonical `documents/` bucket, never `log_generation`, never `list_documents`/`reconcile`. `PUT` the generated file to `uploadUrl`, hand the human `downloadUrl`.

**Isolation guarantees** (all covered by `src/server/preview.test.ts`):
- A preview reflects a staged-but-unpublished edit, while published generation still reflects the old wording.
- After a preview run, the published slot, the pointer, the canonical bucket, `history.json`, and `log_generation` records are **byte-for-byte unaffected**; the only audit added is a distinct **`preview`** event (never an `apply`/`publish`/real-generation record).
- Preview output lives under `previews/` — structurally invisible to the tracked document history.

**No draft?** `preview_generation` returns a clear *"no draft to preview"* notice (and no output) rather than silently previewing published — which would be misleading.

**Who?** Same trust tier as `diff_draft`: **curators and approvers** may preview; unknown / no-role callers are blocked (and the denial is audited). It is read-like, so there is no two-phase confirm and no token.

**Scope.** A preview always targets **one unit + one deliverable** — there is no implicit whole-curriculum preview (generation is LLM-driven and costly).

**Deferred.** A draft-vs-published output *comparison* (previewing both for the same scope so the expert sees exactly what changes in the material) is a follow-on — it doubles LLM cost, and the graph-level change is already available via `diff_draft`.

`get_capabilities` advertises this under a `preview` block, so an agent can offer "want to see what this generates before publishing?".

## Ingesting a doc authored elsewhere (e.g. an expert wrote chapter 2)

1. The file is in the bucket (uploaded any way you like), under the grade/subject's `documents/`.
2. `reconcile` surfaces it as untracked.
3. `get_document_text(relPath)` returns its plain text (server downloads from the bucket and extracts via mammoth — it never calls an LLM).
4. Extract the structured content and call `record_document_content(...)` (**requires confirmation** — call with `confirm: true` after the user approves). Tracked from then on.

## Reconciliation

Run on startup (when a context is active) and via the `reconcile` tool: present + md5 matches history → tracked (skipped); new/changed md5 → untracked (needs ingestion); in history but gone from the bucket → dropped; duplicates for one identity → the object matching the tracked md5 wins, else most-recently-updated.


## Deployment & hosting

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

Both subjects now share the converged `{ nodes, relationships }` envelope + LC metadata scheme and parse through one generic `curriculum/parse-graph.ts::parseGraph` (a thin per-subject descriptor). They still differ in their read PROJECTIONS and deliverables (CI maths → chapters/lessons with a two-axis week/content structure; CE1 reading → weeks/strands), so behaviour is **pluggable per subject** — one **adapter module** per subject owns everything subject-specific in one place.

- **Subject adapter** (`src/adapters/*.ts`) — one module per subject. Each module exposes a common behavior interface: raw-graph `detect`/`parse` (the schema knowledge each subject already owns), the LC→friendly projection (`listUnits`/`slice`/`progression`/`requiredCoverage`/`scopeValues`), `buildGenerationContext`, plus the subject's `deliverables` and `capabilities`. Capability-gated helpers (`suggestFreshDomain`/`domainUsage`, only CI maths today) are optional on the interface. Storage round-trip is handled generically on top of the parsed model by `curriculum/store-bridge.ts` (`serializeModel` / `deserializeToModel`), so no serialize/deserialize methods hang off the adapter.
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
   - *Different shape* → add `src/adapters/<subject>.ts` exporting a `buildXxxAdapter(grade, subject): SubjectAdapter`. The adapter carries everything: raw-envelope `detect`/`parse`, the LC→friendly projection (`listUnits`/`slice`/`progression`/`requiredCoverage`/`scopeValues`), the `deliverables` list (`key`, `label`, `scopeKind`, `classify(filename)`, `dependsOn`, `promptFile` — one per document kind), the `capabilities` flags (`exampleDomainRotation`, `characterConsistency`), and `buildGenerationContext(scope, deliverableKey)`. Optional CI maths-style helpers (`suggestFreshDomain`, `domainUsage`) are only added when the subject enables the matching capability.

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

