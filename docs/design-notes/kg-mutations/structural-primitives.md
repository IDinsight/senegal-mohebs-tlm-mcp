## Step 0 findings for #12 — structural primitives

### The four verbs

`create_node`, `link_nodes`, `unlink_nodes`, `delete_node`. Each is a
single #5 `GraphMutation`, individually confirmed, applied to the draft,
validated by #6, audited by #7, gated by #8 — exactly the shape
`upsert_property` established, just structural. Live in
[`src/kg-store/structural.ts`](../../../src/kg-store/structural.ts); registered
at the tool boundary in
[`src/server/structural.ts`](../../../src/server/structural.ts).

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
(`chapter`/`lesson`/`component`/`task` for CI maths). The declarative
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
