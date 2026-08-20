# KG mutations — the two-phase confirm framework

> **Status: Framework current; recipe surface SUPERSEDED.** The two-phase confirm framework described here is live (dry-run → token → confirm → draft; Rule 1/2 floor; audit; role gate) and unchanged. **BUT the named per-recipe surface below (`add_lesson`/`add_lesson_grouping`/`move_lesson`/`split_lesson_grouping`/`renumber` + the `RecipeProfile`/`structuralAliases` machinery) has been REPLACED** by four GENERIC verbs in the **`kg-recipes`** module — `add_node` / `move_node` / `reposition` / `set_content` — with **no `RecipeProfile`** (a created node's identity is derived from the graph) and no per-subject gating. `split_lesson_grouping` was dropped (it's `add_node` + `move_node`s). Read the recipe-specific sections below as historical; the framework sections still apply. For the current surface see [`../../technical-reference/`](../../technical-reference/README.md) and [`graph-native-authoring.md`](../graph-native-authoring.md). (The Regime-B / `chapitreNum` drift material is also HISTORICAL — see the update note below.)

> **Update (maths↔reading convergence):** the "Regime-B" / `chapitreNum` drift discussion below is HISTORICAL. Chapter↔lesson membership is now the `hasChild` edge (the denormalized number-join is gone), so move/split rewire the edge and renumber changes only the chapter's own number — no cross-lesson cascade, no drift warning. The `regimeGated` recipe flag was removed. See CLAUDE.md.

This is the internal design note for the graph-mutation framework in
[`src/kg-store/mutations.ts`](../../../src/kg-store/mutations.ts). No user-facing
graph edit tool is exposed by this step; the framework only ships with an
internal test-only mutation ([`src/kg-store/__tests__/mutations.test.ts`](../../../src/kg-store/__tests__/mutations.test.ts)).

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
[`src/utils/server.ts`](../../../src/utils/server.ts) as `ConfirmationEnvelope`):

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
[`mutations.test.ts`](../../../src/kg-store/__tests__/mutations.test.ts).

## Draft-apply mechanism

The framework rides on the primitives from #4 in
[`src/kg-store/types.ts`](../../../src/kg-store/types.ts):

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

## Per-subsystem findings

The "Step 0 findings" below were the per-issue design notes; each is now its own file:

- [`write-safety.md`](write-safety.md) — #6 write-safety rules (block vs warn).
- [`audit.md`](audit.md) — #7 append-only audit log, atomic with the change.
- [`roles.md`](roles.md) — #8 curator / approver roles.
- [`draft-lifecycle.md`](draft-lifecycle.md) — #9 + #10 draft lifecycle + `upsert_property`.
- [`capabilities.md`](capabilities.md) — #11 `get_capabilities` (read-only mirror).
- [`structural-primitives.md`](structural-primitives.md) — #12 structural primitives.
- [`integrity.md`](integrity.md) — #13 referential integrity (cascade + coverage).
- [`recipes.md`](recipes.md) — #14 curriculum recipes (composite mutations).
- [`token-only-confirm.md`](token-only-confirm.md) — parking large payloads server-side so a confirm need not re-send them (`edit_profile`, `edit_node`).
