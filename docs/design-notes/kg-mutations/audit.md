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
