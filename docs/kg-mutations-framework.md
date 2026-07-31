# KG mutations — the two-phase confirm framework

This is the internal design note for the graph-mutation framework in
[`src/kg-store/mutations.ts`](../src/kg-store/mutations.ts). No user-facing
graph edit tool is exposed by this step; the framework only ships with an
internal test-only mutation ([`src/kg-store/mutations.test.ts`](../src/kg-store/mutations.test.ts)).

## Two lifecycles, one thin shared convention

The server has **two** kinds of confirmed action and it deliberately does not
unify them:

1. **Graph mutations** (this framework). Target the **draft** slot only.
   Preview returns a diff + a confirmation token; confirm applies to the
   draft. Nothing reaches generation until a **separate publish** step
   (#10) flips the pointer. Because publish is a safety net, a graph confirm
   is lower-stakes per click than a document confirm.
2. **Document operations** (`create_upload_url`, `log_generation`,
   `record_document_content`). Write **live** to the bucket / history. No
   draft, no diff, no publish behind them. The confirm is the ONLY gate,
   which makes each click **higher-stakes**.

They share only a thin **confirmation envelope** (defined in
[`src/utils/server.ts`](../src/utils/server.ts) as `ConfirmationEnvelope`):

```ts
{ needsConfirmation: true, action: string, message: string }
```

- `action` is stakes-accurate phrasing supplied by the caller.
- `message` wraps `action` with the "call again with `confirm: true`"
  instruction that agents follow.

Graph mutations extend this envelope with `phase: "preview"`,
`kind: "graphMutation"`, `diff`, `warnings`, and `confirmationToken`.
Document tools carry only the common three fields — they have no diff or
token because they have nothing to reconcile against a base version.

**Messaging must not flatten stakes.** Graph previews always say
"stages a draft edit on namespace '…'; nothing reaches generation until
you separately publish the draft." Document tools always say "writes NOW
to the live bucket/history (no draft, no undo)." This is asserted in
[`mutations.test.ts`](../src/kg-store/mutations.test.ts).

## Draft-apply mechanism

The framework rides on the primitives from #4 in
[`src/kg-store/types.ts`](../src/kg-store/types.ts):

- Slot model per namespace (`a`/`b`) with an atomic pointer doc
  `{ publishedSlot, draftSlot | null }`.
- `createDraft(ns)` — lazy copy of `publishedSlot` → the free slot; sets
  `draftSlot` last. Idempotent.
- `writeSlot(ns, slot, batch)` — wholesale replace of the target slot.
- Reads default to `publishedSlot`; generation is unaffected by drafts.

There is no per-primitive edit today (#4 only shipped wholesale writes),
so every applied mutation:

1. reads the current draft (or published if none exists),
2. applies the mutation in memory (pure function),
3. re-`writeSlot`s the whole draft with the new state.

Cost is proportional to the draft's total node/edge count. For the CI-maths
graph that is a small write; for larger subjects this could be revisited.

## Stable identifier — the anchor

Every diff key and every apply key runs off the raw stable id:

- **Nodes**: `StoredNode.id` = LC IRI verbatim.
- **Edges**: `StoredEdge.id` = deterministic `edgeId(type, from, to)`.

Friendly properties (`chapitreNum`, `code`, `title`, …) live in
`properties`/`properties.raw` and MUST NOT be used as identity — the #3
finding.

## Decisions (a)–(d) — as implemented

**(a) Confirmation token — YES, minimal.**
Token payload: `{ m: mutation-name, a: sha256(canonical(args)), k: "onDraft"|"onPublished", v: sha256(canonical(baseGraph)), n: random-nonce }`,
base64url-encoded. No signature — a forged token still has to match the
current base version to be accepted, and any mismatch reduces to a
`stale` retry.

On confirm the framework checks:
- token decodes and has all fields;
- `m` matches the mutation being confirmed;
- `a` matches `hashArgs(args)` of the confirm-time args;
- `k` matches the current base slot classification;
- `v` matches the current base graph hash;
- nonce not previously consumed.

Every mismatch has a distinct `reason`: `invalidToken` /
`mutationMismatch` / `argsMismatch` / `stale` / `replay` / `unseeded`.

**(b) One-time use.**
`n` (16 random bytes) is tracked in an in-memory `Set<string>` per Node
process. Rationale: our mutations aren't naturally idempotent at the
framework layer (e.g. "increment order" applied twice ≠ once); one-time
use is the safe default. Nonce is consumed **after** `writeSlot` succeeds
so a legitimate retry after a store error is possible. Cloud Run runs
with a one-instance cap today; if it ever scales out, the nonce set
becomes per-instance — a follow-up would move it onto the pointer doc.

**(c) Validate hook — an empty seam #6 will fill.**
Signature: `validate(base: MutationGraph, args): { errors: string[]; warnings: string[] }`.
- `errors.length > 0` → framework returns a `phase: "blocked"` result
  with the errors and NO token, so confirm has nothing to replay.
- Otherwise → warnings are surfaced in the normal preview envelope, token
  is issued, confirm proceeds.

The default hook (mutation.validate undefined) is a pass-through
`() => { errors: [], warnings: [] }`. Adding write-safety rules
(id-immutability, no-orphan, adapter-specific integrity) is a matter of
supplying a validate on each mutation — no framework change.

**(d) Shared envelope surface.**
- Common (both worlds): `needsConfirmation`, `action`, `message`.
- Graph-only extensions: `phase`, `kind`, `diff`, `warnings`,
  `confirmationToken`. Confirm return: `phase: "apply"` plus `ok` +
  either `{applied, draftSlot, diff}` or `{reason, message}`.

`phase` is the discriminant that lets callers narrow without probing
`in` operators.

## Graph-mutation interface

To add a new graph mutation, implement:

```ts
interface GraphMutation<Args> {
  name: string;                                        // stable id
  describe(args: Args): string;                        // stakes-accurate summary — used in `action`
  validate?(base: MutationGraph, args: Args): { errors: string[]; warnings: string[] };
  apply(base: MutationGraph, args: Args): MutationGraph;   // pure; returns new graph
}
```

Then call the single entry point:

```ts
runGraphMutation({ namespace, mutation, args, confirm?, token? })
```

Preview → confirm → apply plumbing, diff, token, warnings, and draft-only
write are all handled by the framework.

## Scope boundary for this step (#5)

- Framework touches only the curriculum/KG graph. Document tools keep
  their live single-gate confirm; only their `action` phrasing is aligned
  to state the "live write NOW" stakes explicitly.
- No public graph edit tool. `mutations.test.ts` registers one internal
  `setNodeProperty` mutation (plus `deleteNode` and `validatingMutation`
  for reusability + validate coverage) and never calls `registerTool` for
  any of them.
- Validate stays a pass-through. Write-safety rules land in #6.
- No audit, no roles, no capabilities, no lifecycle tools, no version
  pinning, no schema.

## Two open decisions that survived Step 0

Kept in this note so #6/#10 can revisit them:

1. **Base version = sha256 over sorted canonical JSON of nodes+edges.**
   Concrete, no schema-doc changes needed. If we ever want the store to
   optimize the base-version read away, bumping the pointer doc with an
   explicit `draftRevision` counter is a follow-up.
2. **Nonce store is in-memory, per process.** Fine under Cloud Run's
   one-instance cap. If we scale out, replay across instances becomes
   theoretically possible — persist the nonce onto the pointer doc at
   that point.

---

## Step 0 findings for #6 — write-safety rules

### Stable id (anchor for Rule 1)

- Node id = LC IRI verbatim (`StoredNode.id`).
- Edge id = deterministic `edgeId(type, from, to)` (`StoredEdge.id`).
- Both are the `id` field. That's the field Rule 1 protects.

### Reference regime

Confirmed by reading both adapters + `curriculum/store-bridge.ts`:
`serializeModel` externalizes every parent/child + progression link as a
`hasChild` / `buildsTowards` edge, keyed by node id. `properties.raw` holds
subject-specific content passthrough — including values like `chapitreNum`
or `case_identifier_uuid` that the raw parser uses as match keys, but those
are NOT stored id references. **At the store level, all references are
edges.** The denylist is just the `id` key on nodes and edges.

### Interface widening

The framework's `validate` hook previously received `(base, args)`; Rule 2
needs the AFTER graph, so the signature widened to
`validate(base, after, args)`. The framework now:

1. computes `after = mutation.apply(base, args)`;
2. runs `validateStructural(publishedReference, after)` (Rules 1 + 2)
   unconditionally, where `publishedReference` is ALWAYS the current
   published slot's graph — see the #12 note below for why the reference
   is published rather than base;
3. runs `mutation.validate?(base, after, args)` on top;
4. combines errors — anything present blocks confirmation.

Only one caller existed (the internal `validatingMutation` in the test
file); its signature was updated one-line.

### Decisions

**(a) Rules live in one shared function** —
`kg-store/validate.ts::validateStructural`. Both rules are structural and
don't care about subject. No per-adapter machinery. If a future subject
needs a third rule (or an extra protected key), extend the shared function
or hand it an optional extras list — do NOT ship per-adapter validators.

**(b) Both rules are errors, not warnings.** A silent id mutation orphans
references; a dangling edge is a broken graph. Neither is a judgment call.
Warnings stay reserved for future non-blocking hints (e.g. under-coverage
in #14).

### Load-bearing status

- **Rule 1** — fires today, on any mutation that renames a node/edge.
  Covered by both direct tests and framework-integration tests.
- **Rule 2** — built and tested now, but only becomes load-bearing when
  #12 introduces delete/relink mutations. Today no mutation removes
  nodes or edges, so it's trivially satisfied on live traffic; the
  tests exercise it against crafted before/after graphs and via a
  test-only mutation that deliberately leaves dangling edges.

---

## Step 0 findings for #7 — audit log

### #4's atomic unit + version ids

- `publishDraft`, `discardDraft` — single-doc `runTransaction` on the
  pointer. Genuinely atomic. Audit doc joins the same tx.
- `createDraft` — bulk copy first, then a `runTransaction` on the pointer
  to flip `draftSlot`. Audit doc joins that final tx.
- `writeSlot` (used by apply) — chunked bulk writes (Firestore txn cap =
  500 writes), then a final pointer meta touch. Upgraded that touch to a
  `runTransaction` and let the audit doc ride it. Residual crash window
  during bulk writes = pre-existing #4 partial-write issue.
- Version identifiers: reused `hashGraph(...)` from #5 — sha256 of the
  sorted-canonical graph. Same hash as the concurrency token uses.

### #5 diff shape

Already computed inside `runGraphMutation` and returned in the preview
envelope. Stored inline on apply records. Small; keyed by stable id.

### Actor shape

`{ id, email?, tokenIssuer?, unknown: boolean }` from #1's `currentActor()`.
The audit stores it verbatim, including `unknown: true`.

### Decisions

**(a) Single `kg_audit` collection** with `namespace` as a field. Not
per-namespace subcollections. Cross-namespace queries stay cheap.

**(b) Change-detail granularity.**
- Apply → inline diff.
- Publish → `baseVersion` + `resultingVersion` + `promotedApplyIds`. No
  re-diff (that's #10).
- Discard → `discardedApplyIds` + `baseVersion`.
- CreateDraft → `baseVersion` of the source published slot at
  draft-creation time.
- Blocked → `mutation` + `reason` only.

**(c) Blocked attempts audited, lightweight.** Both preview-time
validation failures and confirm-time rejections (stale, replay,
argsMismatch, mutationMismatch, invalidToken, unseeded). Same collection,
`eventType: "blocked"`. No diff, no versions.

**(d) Atomicity mechanism.** Firestore transactions can touch multiple
docs; every committed-change audit rides its state-op's transaction.
Memory backend runs the audit push in the same synchronous block as the
state change. Blocked records have no state to join → plain `appendAudit`.

### Interface

`KgNodeStore` gained `audit?: AuditRecord` on every state-changing method
(optional so the seed script — which is not a runtime graph op — keeps
working). The framework (`runGraphMutation`) always constructs an audit
record for both committed and blocked events; completeness is enforced
at that layer. Also new: `appendAudit(record)` and
`listAudit(filter)` — pure write-only + read surface, no
update/delete method on the interface anywhere.

---

## Step 0 findings for #8 — curator / approver roles

### Supabase role-delivery path

Chosen: **`public.user_roles` table + Custom Access Token Hook**. The
Supabase Auth Hooks feature is available on this project (confirmed via
the dashboard). The hook function reads `user_roles` at token-mint time
and injects `app_role: "curator" | "approver"` into the JWT. The MCP
reads that claim in `resolveActor`.

SQL + docs: `scripts/supabase-user-roles.sql`. Enable the hook once in
Dashboard → Authentication → Hooks. Seed the first approver row via SQL
editor. No MCP tool grants roles — self-escalation surface is zero.

### Wiring point

- `Actor.role?: "curator" | "approver"` — new field on the actor,
  populated only in `resolveActor` from the verified `app_role` claim.
- `authorize(actor, action, namespace)` — pure function in
  [`src/authz.ts`](../src/authz.ts). Takes `namespace` even though roles
  are global today, so per-namespace roles slot in later without changing
  call sites.
- Enforcement chokepoints: `runGraphMutation` (both dry-run and confirm),
  `publishDraft` wrapper, `discardDraft` wrapper — all in
  [`src/kg-store/mutations.ts`](../src/kg-store/mutations.ts).

### Decisions (a)–(d) — as implemented

**(a) GLOBAL role scope.** Scalar `app_role` claim, no per-namespace
dimension. `authorize(actor, action, namespace)` accepts a namespace so
per-namespace can slot in later by changing the claim to
`app_roles: [{namespace, role}, ...]` and updating the single function.

**(b) Self-approve ALLOWED by default, marked in the audit.**
`TLM_ALLOW_SELF_APPROVE=0` flips it to strict. Every publish audit
record carries `selfAuthored: boolean` regardless of the flag.

**(c) Assignment in Supabase, out of the MCP surface.** SQL script
seeds the table + hook function; further grants happen in the Supabase
SQL editor. Enforced by a structural test — no exported symbol looks
like `grantRole` / `setRole` / etc.

**(d) Dry-run also requires curator.** A non-curator has no legitimate
reason to preview edits. Reads and generation stay ungated — an unknown
actor can still call `list_units`, `get_curriculum`,
`get_generation_context`, etc.

### Denial shape

New `phase: "unauthorized"` return from `runGraphMutation`, distinct
from `phase: "blocked"` (validation errors, #6) and `phase: "apply"
ok:false` (stale/replay tokens, #5). Every denial writes one `blocked`
audit record whose `reason` starts with `"unauthorized: ..."`. No token
is issued; no state changes.

---

## Step 0 findings for #9 + #10 — draft lifecycle + upsert_property

### Term-wording targets (from the LC data + adapters)

There is no "glossary node" in the KG; glossary lives in the local
`terminology.json` (out of scope for graph writes). The pilot's
"wording" targets are the human-readable text fields on curriculum
nodes:

- Maths chapter: `properties.title` (was `raw.chapitreTitre`)
- Maths lesson: `properties.text` (was `raw.osTexte`)
- Maths component + task: `properties.text` (was `raw.description`)
- Reading standard + component: `properties.text` (was `raw.description`)
- English mirrors: `raw.*_en` where present

The adapter's `wordingAliases` declares which LOGICAL keys map to which
storage paths per node kind. A curator says `title` / `text` /
`title_en` / `text_en`; the mutation updates every backing path
atomically.

### Whole-draft diff — decision (a)

Structural recompute from the draft slot vs the published slot. Audit
is a log, not a state oracle. `diffDraft(namespace)` reads both slots,
strips slot tags, and calls the existing `diffGraphs`. Same shape as
#5's per-mutation diff but different scope.

### Draft-level token — decision (b)

`{op: "publish"|"discard", ns, dv: hashGraph(draft), n: nonce}`,
base64url-encoded, distinct payload keys from #5's per-mutation token.
Sibling nonce set (`consumedDraftNonces`) so the two token spaces don't
leak into each other. Confirm rejects with `reason: "the draft moved
since dry-run"` if hashes don't match.

### Missing-key rule — decision (c)

Hard error. Wording pilot means fixing existing text; adding new fields
is #12's job. Both layers of validation run:

1. Adapter's wordingAliases must declare the logical key for the
   node's kind (else "wording key 'X' is not editable on node kind
   'Y'").
2. Every resolved storage path must currently hold a non-null string
   on the node (else "path 'X' does not currently exist as text on
   node 'Y'").

### Namespace source — decision (d)

Active context, via `getActiveAdapter()`. Same convention as every
existing tool in this codebase (no tool takes an explicit namespace).

### Adapter surface — why the "clean layer" mattered

Original proposal was dotted paths that the curator supplies directly.
Refactored based on feedback: a curator says `title`, and the adapter
translates it to `["title", "raw.chapitreTitre"]`. Subject-specific
knowledge lives in subject code; the mutation itself is
subject-agnostic. Safety allowlist (`UPSERT_PROPERTY_SAFE_PATHS`) sits
inside the mutation so an adapter cannot expand the editable surface
by declaring an unlisted path.

---

## Step 0 findings for #11 — get_capabilities (read-only mirror)

### The whole point is that it can't lie

Every field in the response is imported from the module that ACTUALLY
enforces or defines it:

- `actor.role` ← `currentActor()` (from #1's verified JWT).
- Every `actions.canX` ← `authorize(actor, action, ns)` — the same
  function every write tool calls. Zero role-mapping logic in the tool.
- `draft.exists` ← `store.readPointer()`; `draft.createdBy` ← the most
  recent `createDraft` audit record.
- `editable.keysByNodeKind` ← `adapter.wordingAliases` (live object).
- `editable.safePaths` ← `UPSERT_PROPERTY_SAFE_PATHS` from mutations.ts.
- `rules.structural` ← `STRUCTURAL_RULES` from validate.ts.

### The mirror-property test

For each of {curator, approver, no-role, unknown} and each gated action,
the test asserts:
```
capabilities.actions[canX] === authorize(actor, X, ns).ok
```
If they ever disagree, the tool is lying or authz has changed — the test
catches drift.

### Decisions (a)–(c) — as implemented

**(a) Live vs static.** Live per-call: `actor`, all `actions.*`,
`draft.exists`, `draft.createdBy`. Sourced from module constants (still
zero drift): `editable.safePaths`, `rules.structural`.

**(b) Unknown-safe.** Unknown callers get a truthful response —
`isKnown: false`, `role: null`, `canReadGenerate: true`, every write
action `false`. Not a 401. Point of the tool.

**(c) `draft.createdBy`.** Included when a draft exists. Cheap
(`listAudit` with `limit: 1`). Helps a second curator see whose draft
they'd be editing.

### New export from validate.ts

Added `STRUCTURAL_RULES: readonly string[]` — human-readable summaries of
Rule 1 and Rule 2. `get_capabilities` imports them so a rule description
change is one file, not two. The validator's own error messages remain
separately worded (they include specifics like the offending id) — this
constant is just the summary Claude tells a curator up-front.

---

## Step 0 findings for #12 — structural primitives

### The four verbs

`create_node`, `link_nodes`, `unlink_nodes`, `delete_node`. Each is a
single #5 `GraphMutation`, individually confirmed, applied to the draft,
validated by #6, audited by #7, gated by #8 — exactly the shape
`upsert_property` established, just structural. Live in
[`src/kg-store/structural.ts`](../src/kg-store/structural.ts); registered
at the tool boundary in
[`src/server/structural.ts`](../src/server/structural.ts).

### Rename-detection anchor — published, not base

Rule 1's rename check compares the proposed state against PUBLISHED, not
against the draft-just-before-this-mutation. That's a semantic change to
the framework's structural-validation call: the framework now reads the
published slot alongside the mutation's base and passes it as the
reference. Why: a disguised rename doesn't have to happen inside a single
mutation. `delete_node(X)` in one mutation followed by
`create_node(X's content under a new id)` in a following mutation on the
same draft — the per-mutation view sees only a lone delete and a lone
create, nothing to pair up. Anchoring at published catches this cross-
mutation pattern; the "headline safety property" of #12. Rule 2 still
only inspects `after` — it's a self-consistency check, no reference
needed.

### id-minting for create_node — tool-layer concern

`apply` must stay pure (dry-run and confirm compute the same `after`), so
the mutation itself cannot call `randomUUID()`. The tool layer generates
one randomUUID per dry-run and threads it into args as `newNodeId`; the
framework's args-hash bakes it into the token, so a confirm can only
apply the same dry-run's mint. The tool response surfaces `mintedNodeId`
at the top level so Claude can pass it back on confirm.

A caller-supplied id is REJECTED at two layers: the tool's input schema
does not declare an `id` parameter (so a `create_node({..., id: "..."})`
call has the extra key stripped by zod); and the mutation's `validate`
hard-rejects `args.properties.id` if a curator tries to sneak identity
in through the wording bag. Node identity is server-only.

### LC-based validation — decision (b), as implemented

LC's own domain/range and class definitions are NOT machine-readable in
this codebase: the raw KG file lists `schemaEntities` and
`schemaRelationships` as flat name lists in metadata, and the adapter's
`parse()` drops even those and replaces them with internal kinds
(`chapter`/`lesson`/`component`/`task` for maths). The declarative
schema was deliberately dropped in earlier steps; #12 does not
reintroduce one.

The minimal check we CAN do without a new source is observational:

- `create_node`'s `kind` must be a kind already present in the graph.
  Rejects `create_node(kind="widget")`.
- `link_nodes`'s `edgeType` must be an edge type already present.
  Rejects `link_nodes(edgeType="hasLesson", ...)` and other invented
  strings.

This is deliberately weaker than a real domain/range schema: it does
NOT enforce cross-kind edge legality (e.g. `hasChild(task→chapter)`
passes these checks even though it's semantically wrong). That judgment
is deferred to human review at publish, as the task specifies. Making
it machine-enforceable would mean adding a `SubjectAdapter.structuralSchema?`
declaration — a real design change and a new source of truth outside
the raw graph. Marked as a follow-up for a future step, not #12.

### create_node — required vs warned properties

Required: `kind` (must be a known kind), `namespace` (from active
context, same convention as every other tool), and the server-minted
id. Everything else is optional.

Warned: the adapter's `wordingAliases[kind]` declared wording keys
that are NOT populated on the proposed properties surface as WARNINGS
(non-blocking) on the preview envelope. Rationale: a freshly created
chapter with no title is INCOMPLETE, not CORRUPT. Rule 2 doesn't care
about lonely or wording-less nodes; the draft → publish review gate
is the completeness check. A warning gives Claude an actionable
follow-up ("also call `upsert_property` to set the title") without
turning create_node into a rigid schema check.

### Floating nodes

A `create_node` without a subsequent `link_nodes` leaves an unlinked
node on the draft. It violates no #6 rule (Rule 2 is about edge
endpoints, not lonely nodes) and doesn't break reads/generation
(presenters walk `hasChild` from a chapter — a chapter with no
children just returns an empty slice, no crash). Fine in a draft;
human review at publish handles completeness.

### delete_node scope — Rule 2 covers everything

No kind-specific special-casing. A chapter with lessons has surviving
`hasChild` edges pointing at it after the delete; those trip Rule 2
automatically. The mutation's own validate ALSO lists the incident
edges up-front — cheaper than making the operator decode a Rule-2
message — but this is a UX niceness, not a rule.

### Non-goals — deliberate deferrals

- **No cascade-on-delete** — delete refuses, doesn't cascade. Cascade
  is #14.
- **No composite / recipe operations** — `add-chapter`, `split-chapter`
  and friends are #13. Multi-primitive sequences still accumulate
  atomically on the draft and publish together via `publish_draft`.
- **No structural-property editing of EXISTING nodes** — renumbering
  a chapter, changing a `statementCode` on a lesson. Separate future
  step. `create_node` sets properties at BIRTH; `upsert_property`
  stays wording-only.
- **No under-coverage / requiredLessonCoverage warnings** — #14.
- **No new schema layer** — validation stays #6 + minimal observed-
  vocabulary checks.

---

## Step 0 findings for #13 — full referential integrity (cascade + coverage)

### The reference regime — resolved: predominantly A, one denormalized B field

The number-vs-id question, traced through both the store and every adapter's
read path:

- **Store referential backbone = 100% id-based edges (Regime A).** Every
  genuine cross-entity link is a `hasChild` or `buildsTowards` edge keyed by
  `from`/`to` node id. Rule 2 already guards all of them. Covers
  lesson→component, component→task, week→standard, standard→component, and
  chapter→chapter progression.
- **Exactly one number-based reference (Regime B), maths only: `raw.chapitreNum`.**
  The maths *presenter* joins a chapter to its lessons by matching
  `raw.chapitreNum` (`lessonsOf` filters `lesson.raw.chapitreNum === chapNum`),
  NOT by the `hasChild` edge. But that chapter→lesson `hasChild` edge ALSO
  exists in the store (serialize emits it from the number-derived `childIds`),
  so `chapitreNum` is a **denormalized copy** of an edge that's already
  Rule-2-protected — not an independent reference.

Enumerated reference sites: `edge.from`/`edge.to` (id, all subjects, Rule 2);
`raw.chapitreNum` (number, maths chapter↔lesson, denormalized); `order` /
`raw.leconNum` (ordering only, not a cross-ref); `code` / `raw.statementCode`
(display only); reading's `raw.case_identifier_uuid` (parse-time join for raw
`supports`, resolved to an id-edge at serialize — not a store-level ref).

**Verified on seed data** (via a serialize + count check): 25 chapters, all
non-empty, each with exactly one bilan, zero `chapitreNum` drift. So none of
the coverage warnings fire on untouched seed data — they only appear once a
curator introduces incompleteness, and parity is unaffected.

### Decision (a) — cascade scope on force-delete

`delete_node(force:true)` removes the target + its **hasChild dependent
subtree** + every incident edge, atomically. "Dependent" = a hasChild
descendant *all* of whose hasChild parents are in the removed set (computed to
a fixpoint in `cascadeRemovedNodeIds`), so a child shared with a surviving
parent stays put (only its edge to the removed parent drops). Progression
neighbours (`buildsTowards`) are NOT dependents — their connecting edge is
removed, they survive. The dry-run diff shows the full removed set; Rule 1/2
re-run on the result. Cascade follows the id-edge backbone; a child attached by
`chapitreNum` number-only (a drift state) is not in the subtree — an accepted
edge case the coverage warnings already flag.

### Decision (b) — the coverage rules (all WARNINGS, never blocks)

Grounded in real curriculum expectations, not invented:
- **Empty container** (generic) — a chapter/week with zero hasChild children.
- **Missing / duplicate bilan** (maths) — a chapter with lessons but no
  `isAssessment` lesson, or more than one.
- **Lesson with >1 parent** (generic) — a hasChild child with two parents.
- **`chapitreNum` drift** (maths, Regime-B consistency) — a lesson whose
  `chapitreNum` disagrees with its hasChild-parent chapter's, or matches no
  chapter at all. This is exactly the check that the denormalized copy still
  agrees with the edge backbone.

### Decision (c) — Regime-B field handling

`raw.chapitreNum` drift is a **WARNING, not a block**: the referential backbone
(the hasChild edge) stays Rule-2-guarded, so drift is presentation
inconsistency (valid-but-suspect), not corruption. Blocking it would force
`create_node`/`link_nodes` to enforce number-matching — a new constraint out of
scope here. **Implication for the future renumber action:** renumbering a
chapter is only reference-safe if it cascade-rewrites every lesson's
`chapitreNum`; the drift warning is precisely the signal that fires if it
doesn't.

### Decision (d) — where warnings surface

BOTH the per-mutation dry-run (`runGraphMutation`, computed on the post-apply
graph) AND the whole-draft `diff_draft` (the approver's pre-publish view). The
`publish_draft` dry-run shows them too, and the publish audit records
`warningsAtPublish` for traceability. Publish is NEVER blocked by warnings.

### Interface / seam

- `validateStructural(publishedReference, after)` unchanged — still the
  universal, id-based BLOCK layer (Rules 1 + 2), no subject vocabulary.
- New optional `SubjectAdapter.coverageWarnings(graph): string[]` — the
  unit-shaped WARN layer. Subject-neutral shapes (empty container, multi-parent)
  are reusable helpers in `curriculum/coverage.ts`; subject-specific rules
  (bilan, `chapitreNum` drift) live in the maths adapter. Reading uses the
  generic helpers only.
- `runGraphMutation` and `diffDraft` gain an optional injected `coverage`
  callback (wired by the server layer from the active adapter) and merge its
  output into `warnings`. `publishDraft` gains an optional `warningsAtPublish`
  recorded on the publish audit. kg-store stays subject-agnostic throughout —
  it only ever calls the injected function, never names a unit kind.
- `deleteNode` gains `force?: boolean`; `apply` branches (isolated-only vs
  subtree cascade), `validate` refuses a connected node only when `!force`.

### Non-goals (unchanged from the task)

No curriculum recipes/composites (that's the next step, which builds on this
layer). No renumber ACTION (this step only ensures integrity knows the number
is denormalized and warns on drift). Warnings never block publish; cascade
never happens without explicit force. No new schema/profile/template layer.

---

## Step 0 findings for #14 — curriculum recipes (composite mutations)

### Restated reference regime (REUSED from #13, not re-derived)

Predominantly **Regime A** (id-based edges), with **exactly one denormalized
Regime-B field: maths `raw.chapitreNum`.**

- **Referential backbone = 100% id-based `hasChild` / `buildsTowards` edges.**
  Rule 2 blocks any dangling edge. Every recipe's rewire runs on this spine, and
  the note about "hasLesson" in the task is nominal only — the store's
  chapter→lesson relation is a `hasChild` **edge**, not an edge type named
  "hasLesson".
- **`raw.chapitreNum` is a number-based reference the maths PRESENTER joins on.**
  `lessonsOf` filters `lesson.raw.chapitreNum === chapNum`, NOT the hasChild
  edge. That edge also exists (denormalized copy), so the number is a copy of an
  already-Rule-2-guarded edge. #13 resolved its drift as a **WARNING, not a
  block** (decision (c)): the backbone stays intact, so drift is a presentation
  inconsistency, not corruption.

**Enumerated referrers a recipe must keep consistent:** `edge.from`/`edge.to`
(id — Rule 2, blocks); `raw.chapitreNum` (number — maths chapter↔lesson join;
drift WARNED); `order` / `raw.leconNum` (within-chapter ordering only); `code` /
`raw.statementCode` (display only, NOT a reference).

**The load-bearing consequence, honestly stated:** because #13 chose WARN not
BLOCK for `chapitreNum` drift, a recipe's safety comes from **the recipe itself
cascade-rewriting** the affected `chapitreNum` family atomically (so no drift
warning fires), **not** from Rule 2 hard-blocking. Rule 2 only blocks genuine
EDGE dangling, and a structural-property edit never dangles an edge, so Rule 2
never fires for renumber. This means **move_lesson and split_chapter are
Regime-B-affected too**, not just renumber: rewiring the hasChild edge without
rewriting the moved lesson's `chapitreNum` would leave it rendering under its
OLD chapter. All three rewrite `chapitreNum` as part of the same composite —
which is why they share one structural-property edit path. The renumber cascade
is **bounded** (one chapter + its direct hasChild lessons, ~5–20 nodes) — not a
large cascade, so no stop-and-report was needed.

### The recipe model (as built)

A recipe is a SINGLE #5 `GraphMutation` whose `apply(base,args)` composes several
#12 primitive `apply` functions (`createNode` / `linkNodes` / `unlinkNodes`) +
structural-property edits, all pure and atomic. The framework gives it, for
free: one whole-composite diff + one token on dry-run (no state change); #13's
`validateStructural` (Rule 1 + Rule 2) over the WHOLE resulting draft; coverage
warnings; one #7 audit `apply` event tagged with the recipe name; #8's role
gate. An invalid composite is rejected as a WHOLE (validate blocks the token) —
nothing partial lands. Recipes are NOT Claude orchestrating separate primitive
calls. Lives in [`src/kg-store/recipes.ts`](../src/kg-store/recipes.ts); tools in
[`src/server/recipes.ts`](../src/server/recipes.ts).

Subject-agnosticism is preserved exactly as #10/#12 did it: kg-store never names
"chapter"/"lesson"/"hasChild". Each recipe reads that vocabulary from a
`RecipeProfile` + `structuralAliases` + `wordingAliases` threaded through its
args; the server tool layer reads them off the active adapter. A subject with no
`recipeProfile` (reading, today) simply has no recipes — the tool returns a
clear "not available" message.

### Decisions (a)–(f) — as implemented (all recommended options, user-confirmed)

**(a) Editable structural keys — minimal set.** `order`, `raw.chapitreNum`,
`raw.leconNum`, gated by a central `STRUCTURAL_EDIT_SAFE_PATHS` allowlist in
kg-store (the exact analogue of `UPSERT_PROPERTY_SAFE_PATHS`, kept separate so
wording and structure never blur). Exposed via a `structuralAliases` map on the
adapter (same shape as `wordingAliases`): `chapter.number → [order,
raw.chapitreNum]`; `lesson.chapterNumber → [raw.chapitreNum]`; `lesson.position
→ [order, raw.leconNum]`. Values are numeric; the "existing key must hold a
number" discipline mirrors #10. `code`/`statementCode` are display-only and stay
out.

**(b) Preserve numbers; renumber only when explicit.** move/split set only the
MOVED lessons' `chapterNumber` to their new home's number (mandatory for
correctness); they never touch other chapters' numbers, and they preserve each
moved lesson's within-chapter position.

**(c) add_chapter = append / gap-fill only.** The number must be FREE; a
colliding number is rejected in the additive path. Inserting BETWEEN chapters
(shifting the rest) is out of the additive path.

**(d) Edge rewiring.** move/split unlink the old `hasChild(oldChapter→lesson)`
and link `hasChild(newChapter→lesson)` + rewrite `chapitreNum`; Rule 2 validates
the whole result; coverage warns (e.g. a chapter left without a bilan) but never
blocks. Verified in tests.

**(e) Recipes-only (user-confirmed).** The structural-property edit path is an
internal mutation used by the recipes; there is NO raw `set_structural_property`
tool. A raw `chapitreNum` edit is exactly the drift the recipes exist to prevent.

**(f) Capabilities = a MIRROR of the registry.** `get_capabilities` renders the
`RECIPES` array straight from `recipes.ts` (never a hand-authored list), marking
each recipe `renumberBearing` (renumber) and `regimeGated` (move/split/renumber
— the ones that rewrite the `chapitreNum` join key). It also mirrors the
editable structural keys (adapter `structuralAliases` + the safe-path allowlist).

### Renumber under this regime — the one recipe whose risk is regime-dependent

`renumber(chapterId, newNumber)` (user-confirmed **free-number only**): it
rewrites the chapter's number (`order` + `raw.chapitreNum`) AND cascade-rewrites
every child lesson's `raw.chapitreNum` in the same atomic composite, so the
family stays consistent and no drift warning fires. The target number must be
FREE — renumber MOVES a chapter to an unoccupied number; insert-with-shift and
swap are explicitly rejected (a separate, larger operation not built here).

### Recipe signatures

- `add_lesson(chapterId, text, [text_en, order, isBilan])` — create lesson +
  `hasChild` link; sets the lesson's `chapterNumber` from the chapter. Additive.
- `add_chapter(number, title, [title_en, lessons[]])` — create chapter (+ seed
  lessons) as one composite; `number` must be free.
- `move_lesson(lessonId, toChapterId, [position])` — unlink + relink + rewrite
  `chapterNumber`; append by default.
- `split_chapter(chapterId, atLessonId, [newTitle, newTitle_en, newNumber])` —
  new chapter (appended at max+1 by default) + move tail lessons + rewrite their
  `chapterNumber`.
- `renumber(chapterId, newNumber)` — chapter number + child lessons' cascade;
  free number only.

Recipes that create nodes mint the id(s) server-side and surface them on the
dry-run (`mintedLessonId` / `mintedChapterId` / `mintedLessonIds`), exactly as
`create_node` surfaces `mintedNodeId`; the caller passes them back on confirm.

### Non-goals (unchanged)

Recipes are the only composites; #12 primitives stay atomic single ops.
Structural editing is limited to the curated key set (wording stays #10). No
cascade beyond #13's explicit force; no silent renumber. Coverage is WARNED,
never BLOCKED by recipes. No new schema/profile/template layer.
