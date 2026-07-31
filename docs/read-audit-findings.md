# read_audit — findings & design note

Phase-1 hardening. `read_audit` is a filtered, paginated, **read-only** view of the
append-only audit log (#7), gated to **approvers** via the existing authorize()
chokepoint (#8), scoped to the caller's current `set_context` namespace (#3), and
advertised through `get_capabilities` (#11). It replaces the manual Firestore-console
check as the supported way to review the trail.

It is deliberately a **reader, not analytics** — query → page of records. No dashboards,
no anomaly detection, no aggregations/exports. Richer audit tooling, if ever needed, is a
separate later step (same discipline that keeps `get_capabilities` a mirror).

## Step 0 — what the audit log actually is (verified, not assumed)

### Record shape (`src/kg-store/types.ts`)
One flat `AuditRecord` covers every event; fields are populated per `eventType`:

| field | when populated |
|---|---|
| `id` (uuid, also the Firestore doc id) | always |
| `ts` (ISO-8601 UTC) | always |
| `actor` (`AuditActor`: id, email, tokenIssuer, role, unknown) | always |
| `namespace` | always |
| `eventType` | always — `apply \| createDraft \| publish \| discard \| blocked \| preview` (this step adds `read`) |
| `mutation` | apply, blocked |
| `baseVersion` / `resultingVersion` | apply, createDraft, publish, discard |
| `diff` (`GraphDiff`, inline) | apply |
| `promotedApplyIds` | publish |
| `discardedApplyIds` | discard |
| `selfAuthored` | publish — true if the approver authored an edit in the promoted chain |
| `warningsAtPublish` | publish — coverage warnings present at publish time |
| `reason` | blocked (why), preview (what was previewed) |

`AuditActor` fields are normalized to `null` (never `undefined`) by the single funnel
`toAuditActor(actor)` — Firestore rejects `undefined` on write.

### Storage & indexing (`src/kg-store/firestore.ts`, `memory.ts`)
- Firestore collection **`kg_audit`**; doc id = record `id`. Written via `set` on a fresh
  doc id **only** — no code path calls `update()`/`delete()` on these docs. State-change
  events ride their state write's transaction; `blocked`/`preview`/`read` are plain
  appends.
- The store interface (`KgNodeStore`) exposes **only** `appendAudit` + `listAudit` — no
  update/delete surface (asserted by `audit.test.ts`). This is the append-only barrier
  `read_audit` inherits for free: reusing these two methods, it *cannot* alter the log.
- `listAudit(query)` coarse-filters server-side by whatever indexes cheaply (namespace,
  eventType, actorId, ts-range), then re-applies `matchesAuditQuery` locally and
  `sortAuditNewestFirst` (ts desc, id desc tiebreak), slicing to `limit`. Ordering is
  therefore already newest-first and stable.

### Gating (`src/authz.ts`)
Single `authorize(actor, action, ns)` chokepoint. `publish` is the only approver-only
action today; `apply|discard|readDraft` allow curator+approver; unknown/no-role are
denied. `read_audit` extends this same function with a new **`readAudit`** action
(approver-only — same allow set as `publish`), rather than a parallel check.

## Decisions (a–f)

**(a) Filters — exactly this set, no more:**
- `actor` — `AuditQuery.actorId`.
- `action` — `AuditQuery.eventType` (apply/createDraft/publish/discard/blocked/preview/read).
- `outcome` — `applied | blocked`, applied in the reader: `blocked` ≡ `eventType==="blocked"`;
  `applied` ≡ every other (successful) event. Composable with `action`.
- time range — `since` / `until` (inclusive ISO-8601) → `AuditQuery.sinceTs/untilTs`.
- `nodeId` — entries **touching** a node, applied in the reader by scanning an `apply`
  record's inline `diff`: node id in `nodes.added/removed/changed`, or an edge whose id
  (`<type>:<from>-><to>`) names the node as `from`/`to`. Non-apply events carry no diff and
  never match a nodeId filter.
- **namespace is NOT a filter argument** — see (e).

No query language, aggregation, or export. That's the whole surface.

**(b) Pagination & ordering — newest-first, opaque (ts,id) cursor, page-size cap.**
Default page size 25, hard cap 100. The reader delegates to `listAudit` (namespace +
actor + action + time coarse-filtered server-side), applies the reader-only filters
(outcome, nodeId), then paginates with an opaque base64 cursor encoding the last returned
record's `(ts, id)`; the next page returns records strictly older than that boundary
(`ts < cursor.ts`, or `ts == cursor.ts && id < cursor.id`, matching the sort). A
`nextCursor` is returned only when more remain.
*Honest scale caveat:* this loads the namespace's matching records into memory per call
(it does **not** stream pages from Firestore) — the same load-then-slice design `listAudit`
already has. Fine at current single-namespace scale. A true Firestore
`orderBy(ts desc)+startAfter+limit` cursor (store-interface + both-backends change, plus a
composite index) is the clean upgrade if volume grows; deliberately deferred to keep this
step small and index-free.

**(c) Payload — summary by default, detail on request.**
- `summary` (default): `auditId, ts, actor {id,email,role,unknown}, action (eventType),
  outcome, namespace, selfAuthored?, target` — where `target` is a one-line descriptor
  derived per event (apply: "N changed, M added, K removed" from the diff; publish:
  "promoted N applies" + self-approve/warning flags; discard: "discarded N applies";
  blocked: `mutation` + short reason; preview/read: short reason). No before/after.
- `detail`: the **full** `AuditRecord` (including `diff` before/after, `promotedApplyIds`,
  `warningsAtPublish`, …). Selected by `mode:"detail"`, or automatically when a single
  `auditId` is requested.

**(d) Read-logging — YES, as a distinct lightweight `read` event.**
Calling `read_audit` appends one `read` record: `actor + ts + namespace + eventType:"read"
+ readQuery` (compact JSON of the filters/mode/cursor) + `readCount` (records returned).
**Never** a before/after, diff, or snapshot. Non-recursive: the read-event is a plain
`appendAudit` performed *after* the query returns — it triggers no further read. Growth is
linear (one record per call), never recursive; because it carries no snapshot it cannot
bloat. Read-events are first-class and **visible + filterable** in `read_audit` results
(so "who reviewed history" is answerable), filterable out via `action`/`outcome`. A
*blocked* read (curator/no-role) is audited as a `blocked` record (not a `read`), same as
every other denial.

**(e) Namespace scoping — strict: current context only.**
`read_audit` resolves the namespace from the active adapter (`kgNamespace(grade, subject)`),
exactly like every other tool. There is **no** namespace argument. An approver on ci/maths
sees ci/maths entries only; to read another namespace they must `set_context` to it. This
is the tightest honoring of the requirement.

**(f) Role — approver-only this version.**
Gated via `authorize(actor, "readAudit", ns)` → allowed only for `approver`. Curator and
no-role/unknown are **blocked**, and each blocked read is itself audited (a `blocked`
record with `reason: "unauthorized: …"`). Widening (e.g. curator-reads-own-history) is a
possible later step, deliberately out of scope here.

## Signature

```
read_audit({
  actor?:   string,                    // actorId
  action?:  AuditEventType,            // apply|createDraft|publish|discard|blocked|preview|read
  outcome?: "applied" | "blocked",
  nodeId?:  string,                    // entries whose apply-diff touches this node
  since?:   string,                    // inclusive ISO-8601
  until?:   string,                    // inclusive ISO-8601
  auditId?: string,                    // fetch one record; implies detail
  mode?:    "summary" | "detail",      // default summary
  cursor?:  string,                    // opaque; from a prior page's nextCursor
  limit?:   number,                    // page size, default 25, cap 100
}) -> {
  namespace, mode, records: [...], nextCursor?, count,
  // or { phase:"unauthorized", action:"readAudit", reason } when denied
}
```

Approver-only · read-only · namespace-scoped. Appends exactly one lightweight `read`
event per successful call. Cannot create/edit/delete/redact/reorder any record — the
append-only guarantee of #7 is preserved absolutely.

## Non-goals (explicit)
Read-only over the log; no write/edit/delete/redact/reorder of entries, ever. Not
analytics/dashboards/anomaly detection. Filters limited to the set above. Approver-only
(no curator-reads-own-history yet). No new schema/store — reads the existing #7 log in
place. No change to how #7 writes records, beyond adding the `read` event type + its two
lightweight fields (`readQuery`, `readCount`).
