// ── Module: server · tool group: read_audit (approver-gated audit reader) ────
// A filtered, paginated, READ-ONLY view over the append-only audit log (#7),
// gated to APPROVERS via the same authorize() chokepoint that gates publish
// (#8), and scoped to the caller's current set_context namespace (#3). It is
// the supported way to review the trail — replacing the manual Firestore-console
// check — and it CLOSES the audit-readback verification.
//
// Design guardrails (see docs/design-notes/read-audit-findings.md):
//   • READER, NOT ANALYTICS. query → page of records. No dashboards, no
//     anomaly detection, no aggregations/exports.
//   • STRICTLY READ-ONLY. It reuses ONLY the store's read/append surface
//     (listAudit + appendAudit) — there is no update/delete on the interface,
//     so this tool structurally CANNOT alter, redact, or reorder a record.
//     The append-only guarantee of #7 is preserved absolutely.
//   • NAMESPACE-SCOPED, STRICTLY. The namespace is resolved from the active
//     adapter (like every other tool); there is deliberately NO namespace
//     argument. To read another namespace an approver must set_context to it.
//   • LIGHTWEIGHT, NON-RECURSIVE READ-EVENT. Each successful call appends ONE
//     `read` audit record (actor + query + ts + count) — never a before/after.
//     It is appended AFTER the query returns, so it triggers no further read;
//     growth is linear, never recursive, and carries no snapshot to bloat with.
//
// The tool body delegates to the exported `readAudit` core so tests drive the
// real logic directly (same pattern as preview.ts / capabilities.ts).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { getKgStore, kgNamespace, toAuditActor } from "../kg-store/index.js";
import type { AuditEventType, AuditQuery, AuditRecord } from "../kg-store/index.js";
import { authorize } from "../authz.js";
import { currentActor } from "../actor.js";

// Page defaults. Kept small — this is a reader, not a bulk export.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// The event types the `action` filter accepts, and the `read` type this tool
// itself emits. Validated so a typo returns a helpful error rather than an
// empty page that looks like "nothing happened".
const EVENT_TYPES: readonly AuditEventType[] = [
  "apply", "createDraft", "publish", "discard", "blocked", "preview", "read",
];

export type ReadAuditArgs = {
  actor?: string;                    // actorId
  action?: string;                   // AuditEventType
  outcome?: "applied" | "blocked";
  nodeId?: string;                   // entries whose apply-diff touches this node
  since?: string;                    // inclusive ISO-8601
  until?: string;                    // inclusive ISO-8601
  auditId?: string;                  // fetch one record; implies detail
  mode?: "summary" | "detail";
  cursor?: string;                   // opaque; from a prior page's nextCursor
  limit?: number;
};

// ── Cursor: opaque base64 of the boundary record's (ts, id) ──────────────────
// The sort is (ts desc, id desc) — see sortAuditNewestFirst — so the "next"
// page is everything strictly older than the boundary under that same order.
type Cursor = { ts: string; id: string };

const encodeCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify(c), "utf8").toString("base64");

function decodeCursor(s: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as Cursor).ts === "string" && typeof (parsed as Cursor).id === "string") {
      return parsed as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}

// Strictly-older-than test in the (ts desc, id desc) ordering: a record is on
// the "next page" iff its ts is older, or the ts ties and its id sorts lower.
const isOlderThan = (r: AuditRecord, c: Cursor): boolean =>
  r.ts < c.ts || (r.ts === c.ts && r.id < c.id);

// ── nodeId filter: does an apply record's inline diff touch this node? ────────
// Only `apply` records carry a diff; every other event type (createDraft,
// publish, discard, blocked, preview, read) has none, so a nodeId filter
// excludes them by construction. We match a node id in the node diff directly,
// and an EDGE that names the node as its from/to — checked against the edge's
// before/after object (robust) and, as a fallback, its parsed id.
function edgeEntryTouches(entry: { id: string; before?: unknown; after?: unknown }, nodeId: string): boolean {
  for (const side of [entry.before, entry.after]) {
    if (side && typeof side === "object") {
      const e = side as { from?: unknown; to?: unknown };
      if (e.from === nodeId || e.to === nodeId) return true;
    }
  }
  // Fallback to the deterministic edge id `<type>:<from>-><to>` when neither
  // before nor after carried the fields (shouldn't happen, but be safe).
  const colon = entry.id.indexOf(":");
  if (colon >= 0) {
    const [from, to] = entry.id.slice(colon + 1).split("->");
    if (from === nodeId || to === nodeId) return true;
  }
  return false;
}

function applyTouchesNode(r: AuditRecord, nodeId: string): boolean {
  const d = r.diff;
  if (!d) return false;
  for (const group of [d.nodes.added, d.nodes.removed, d.nodes.changed]) {
    if (group.some((e) => e.id === nodeId)) return true;
  }
  for (const group of [d.edges.added, d.edges.removed, d.edges.changed]) {
    if (group.some((e) => edgeEntryTouches(e, nodeId))) return true;
  }
  return false;
}

// ── Summary projection ────────────────────────────────────────────────────────
// Compact record: actor, action, outcome, ts, auditId, self-authorship, and a
// one-line `target` descriptor. NEVER a before/after — that's detail mode.
const outcomeOf = (r: AuditRecord): "applied" | "blocked" =>
  r.eventType === "blocked" ? "blocked" : "applied";

const truncate = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function diffCounts(r: AuditRecord): string {
  const d = r.diff;
  if (!d) return "";
  const parts: string[] = [];
  const n = d.nodes.added.length + d.nodes.removed.length + d.nodes.changed.length;
  const e = d.edges.added.length + d.edges.removed.length + d.edges.changed.length;
  if (n) parts.push(`${d.nodes.added.length} added / ${d.nodes.changed.length} changed / ${d.nodes.removed.length} removed node(s)`);
  if (e) parts.push(`${d.edges.added.length} added / ${d.edges.changed.length} changed / ${d.edges.removed.length} removed edge(s)`);
  return parts.join("; ");
}

// One-line human descriptor of WHAT the event touched — derived per event type
// from fields the record already carries. Kept short; detail mode has the rest.
function describeTarget(r: AuditRecord): string {
  switch (r.eventType) {
    case "apply":
      return truncate([r.mutation, diffCounts(r)].filter(Boolean).join(" — "));
    case "createDraft":
      return "draft created from published";
    case "publish": {
      const bits = [`promoted ${r.promotedApplyIds?.length ?? 0} apply(ies)`];
      if (r.selfAuthored) bits.push("self-approved");
      if (r.warningsAtPublish?.length) bits.push(`${r.warningsAtPublish.length} warning(s)`);
      return bits.join(" · ");
    }
    case "discard":
      return `discarded ${r.discardedApplyIds?.length ?? 0} apply(ies)`;
    case "blocked":
      return truncate([r.mutation, r.reason].filter(Boolean).join(": "));
    case "preview":
      return truncate(r.reason ?? "preview");
    case "read":
      return truncate(`returned ${r.readCount ?? 0} record(s)${r.readQuery ? ` · ${r.readQuery}` : ""}`);
  }
}

function toSummary(r: AuditRecord): Record<string, unknown> {
  const s: Record<string, unknown> = {
    auditId: r.id,
    ts: r.ts,
    actor: { id: r.actor.id, email: r.actor.email, role: r.actor.role, unknown: r.actor.unknown },
    action: r.eventType,
    outcome: outcomeOf(r),
    namespace: r.namespace,
    target: describeTarget(r),
  };
  // Surface self-authorship on publish summaries so an audit review can spot
  // self-approval without switching to detail mode.
  if (r.eventType === "publish") s.selfAuthored = r.selfAuthored ?? false;
  return s;
}

// ── Denial (approver-only), itself audited as a blocked read ─────────────────
async function denyIfNotAuditReader(ns: string): Promise<Record<string, unknown> | null> {
  const actor = currentActor();
  const authz = authorize(actor, "readAudit", ns);
  if (authz.ok) return null;
  // A blocked read is recorded as a `blocked` event (not a `read`) — same as
  // every other denial in the system. Lightweight: no diff, no snapshot.
  await getKgStore().appendAudit({
    id: randomUUID(),
    ts: new Date().toISOString(),
    actor: toAuditActor(actor),
    namespace: ns,
    eventType: "blocked",
    reason: `unauthorized: ${authz.reason}`,
  });
  return { phase: "unauthorized", action: "readAudit", reason: authz.reason };
}

// ── Core: read_audit ──────────────────────────────────────────────────────────
export async function readAudit(args: ReadAuditArgs): Promise<Record<string, unknown>> {
  const adapter = getActiveAdapter();
  const ns = kgNamespace(adapter.grade, adapter.subject);

  // 1. Approver-only gate (blocked reads are audited).
  const denied = await denyIfNotAuditReader(ns);
  if (denied) return denied;

  // 2. Validate the (few) enumerated inputs before any read.
  if (args.action != null && !EVENT_TYPES.includes(args.action as AuditEventType)) {
    return { error: `Unknown action '${args.action}'. Valid: ${EVENT_TYPES.join(", ")}.` };
  }
  if (args.outcome != null && args.outcome !== "applied" && args.outcome !== "blocked") {
    return { error: `Unknown outcome '${args.outcome}'. Valid: applied, blocked.` };
  }
  const cursor = args.cursor != null ? decodeCursor(args.cursor) : null;
  if (args.cursor != null && cursor == null) {
    return { error: "Invalid cursor — pass a cursor returned by a prior read_audit page, or omit it to start from the newest." };
  }
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  const store = getKgStore();

  // 3. Single-record detail short-circuit. auditId implies detail; still
  //    namespace-scoped, so a record in another namespace is not returned.
  if (args.auditId != null) {
    const [match] = (await store.listAudit({ namespace: ns })).filter((r) => r.id === args.auditId);
    await appendReadEvent(ns, args, match ? 1 : 0);
    if (!match) {
      return { namespace: ns, mode: "detail", count: 0, records: [], notFound: `No audit record '${args.auditId}' in namespace '${ns}'.` };
    }
    return { namespace: ns, mode: "detail", count: 1, records: [match] };
  }

  // 4. Coarse server-side filter (namespace + actor + action + time). We do
  //    NOT pass a limit here — the reader-only filters (outcome, nodeId) and
  //    the cursor slice run below, so limiting server-side would truncate
  //    before they apply. listAudit already returns newest-first.
  const query: AuditQuery = { namespace: ns };
  if (args.actor != null) query.actorId = args.actor;
  if (args.action != null) query.eventType = args.action as AuditEventType;
  if (args.since != null) query.sinceTs = args.since;
  if (args.until != null) query.untilTs = args.until;

  let rows = await store.listAudit(query);

  // 5. Reader-only filters.
  if (args.outcome != null) rows = rows.filter((r) => outcomeOf(r) === args.outcome);
  if (args.nodeId != null) rows = rows.filter((r) => applyTouchesNode(r, args.nodeId!));

  // 6. Cursor slice (strictly older than the boundary), then page.
  if (cursor) rows = rows.filter((r) => isOlderThan(r, cursor));
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ ts: last.ts, id: last.id }) : undefined;

  const mode: "summary" | "detail" = args.mode === "detail" ? "detail" : "summary";
  const records = mode === "detail" ? page : page.map(toSummary);

  // 7. The lightweight, non-recursive read-event — appended AFTER the query so
  //    it can never feed back into this read. Count reflects the page size.
  await appendReadEvent(ns, args, page.length);

  return {
    namespace: ns,
    mode,
    count: page.length,
    records,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

// Append exactly one `read` audit event. Records actor + a compact JSON of the
// query + timestamp + count returned. NEVER a before/after or snapshot.
async function appendReadEvent(ns: string, args: ReadAuditArgs, count: number): Promise<void> {
  // A compact, stable projection of the query — omitting undefined fields and
  // the (opaque, unbounded) cursor payload, of which we keep only a boolean.
  const q: Record<string, unknown> = {};
  if (args.actor != null) q.actor = args.actor;
  if (args.action != null) q.action = args.action;
  if (args.outcome != null) q.outcome = args.outcome;
  if (args.nodeId != null) q.nodeId = args.nodeId;
  if (args.since != null) q.since = args.since;
  if (args.until != null) q.until = args.until;
  if (args.auditId != null) q.auditId = args.auditId;
  if (args.mode != null) q.mode = args.mode;
  if (args.cursor != null) q.paged = true;
  if (args.limit != null) q.limit = args.limit;

  await getKgStore().appendAudit({
    id: randomUUID(),
    ts: new Date().toISOString(),
    actor: toAuditActor(currentActor()),
    namespace: ns,
    eventType: "read",
    readQuery: truncate(JSON.stringify(q), 300),
    readCount: count,
  });
}

export function registerAuditTools(server: McpServer) {
  server.registerTool(
    "read_audit",
    {
      title: "Review the audit trail",
      description:
        "Read a page of the append-only audit log for the ACTIVE grade/subject namespace, newest-first. APPROVERS ONLY (same tier as publish); curators and no-role callers are blocked (and the blocked read is itself audited). READ-ONLY — it cannot create, edit, delete, redact, or reorder any audit record. Namespace-scoped: to review another namespace, set_context to it first (there is no namespace argument). " +
        "Filters (all optional, AND-combined): actor (actorId), action (one of apply|createDraft|publish|discard|blocked|preview|read), outcome (applied|blocked), nodeId (entries whose apply-diff touches that node), since/until (inclusive ISO-8601). Pagination: limit (default 25, max 100) + an opaque cursor — pass back the returned nextCursor to get the next page. " +
        "Modes: 'summary' (default) returns compact records (actor, action, outcome, ts, auditId, self-authorship, one-line target) with NO before/after; 'detail' returns the full record including the before/after diff. Pass auditId to fetch one record in detail. " +
        "Calling this appends ONE lightweight 'read' audit event (actor + query + timestamp + count) — never a before/after — so 'who reviewed history' stays answerable. This is the supported way to review the trail; it is deliberately a reader, not analytics.",
      inputSchema: {
        actor: z.string().optional(),
        action: z.enum(["apply", "createDraft", "publish", "discard", "blocked", "preview", "read"]).optional(),
        outcome: z.enum(["applied", "blocked"]).optional(),
        nodeId: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        auditId: z.string().optional(),
        mode: z.enum(["summary", "detail"]).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().optional(),
      },
    },
    guarded(async (a: ReadAuditArgs) => asJson(await readAudit(a))),
  );
}
