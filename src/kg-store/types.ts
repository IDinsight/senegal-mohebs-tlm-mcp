// ── Module: kg-store · internal ──────────────────────────────────────────────
// The generic node/edge store that curriculum + KG read paths hydrate from
// when KG_SOURCE=firestore. Deliberately shape-agnostic: two collections,
// each with an id/type/namespace/slot/properties tuple — no CI-CI-maths-specific
// fields bake into storage.
//
// State model (draft vs published): each namespace can hold at most two
// slots' worth of data ("a" and "b"). A single per-namespace pointer doc
// says which slot is currently published, and (optionally) which slot holds
// the in-progress draft — see StoredPointer. All external reads resolve to
// the published slot. Publish is a single-doc pointer flip, which is
// therefore atomic; concurrent readers either see the pre-publish snapshot
// or the post-publish one, never a mix.

export type Slot = "a" | "b";

export type StoredNode = {
  id: string;                              // verbatim from the raw graph
  type: string;                            // CurriculumUnit.kind — "chapter","lesson",…
  namespace: string;                       // "${basePrefix}<grade>/<subject>"
  slot: Slot;                              // which slot this doc belongs to
  properties: Record<string, unknown>;     // normalized fields + raw passthrough
  labels?: string[];                       // raw LC top-level labels, preserved verbatim for faithful re-export
  spine?: boolean;                         // true = part of the read spine (chapters/lessons/…); false = framework/derived node kept only for faithful re-export
};

export type StoredEdge = {
  id: string;                              // stable per (from,to,type,namespace)
  type: string;                            // "hasChild" | "supports" | "relatesTo" | "buildsTowards"
  from: string;                            // node id
  to: string;                              // node id
  namespace: string;
  slot: Slot;
  properties: Record<string, unknown>;     // raw LC edge properties (carries the original edge `identifier` for re-export)
  seq?: number;                            // original position in the raw relationships array — the deterministic order hydration replays through the parser
};

// Per-namespace provenance stamp. One StoredMeta per (namespace, slot), so a
// published slot and a draft slot can carry independent stamps.
export type StoredMeta = {
  contentHash: string;                     // sha256 hex of the raw KG bundle
  seededAt: string;                        // ISO-8601 UTC
  adapterId: string;                       // e.g. "ci-maths/nodes-relationships-v1"
  nodeCount: number;
  edgeCount: number;
};

// Draft/published pointer for one namespace. `publishedSlot` is always set once
// the namespace has been seeded. `draftSlot`, when set, MUST differ from
// `publishedSlot` (two slots total). The pointer doc is the atomic swap point:
// publish = single set() on this doc, flipping the two fields.
export type StoredPointer = {
  publishedSlot: Slot;
  draftSlot: Slot | null;
};

export const otherSlot = (s: Slot): Slot => (s === "a" ? "b" : "a");

// Deterministic edge id — same (type, from, to) always yields the same id, so a
// re-seed or a re-link overwrites the same document instead of appending. Lives
// here (leaf) so BOTH curriculum/store-bridge (which builds edges when it
// serializes a model) and kg-store/structural (which mints edge ids when it
// links nodes) can share ONE definition without importing each other — that
// mutual import previously formed a cycle through the kg-store barrel.
export const edgeId = (type: string, from: string, to: string) => `${type}:${from}->${to}`;

// Input shape for writeSlot. `slot` is added by the store at write time — the
// caller passes the logical graph, not the wire representation.
export type SlotWriteBatch = {
  nodes: Array<Omit<StoredNode, "slot">>;
  edges: Array<Omit<StoredEdge, "slot">>;
  meta: StoredMeta;
};

export interface KgNodeStore {
  readonly kind: "firestore" | "memory";

  // ── Reads (slot-scoped) ────────────────────────────────────────────────────
  // Callers resolve slot via readPointer() first; this interface deliberately
  // takes an explicit slot so no ambient state can leak the "wrong" version.
  listNodes(namespace: string, slot: Slot): Promise<StoredNode[]>;
  listEdges(namespace: string, slot: Slot): Promise<StoredEdge[]>;
  readMeta(namespace: string, slot: Slot): Promise<StoredMeta | null>;
  readPointer(namespace: string): Promise<StoredPointer | null>;

  // ── Wholesale slot write (seed + createDraft's internal copy + apply) ──────
  // Idempotent: after this returns, the store's state for (namespace, slot)
  // equals exactly the passed nodes/edges/meta. Stale docs in that slot are
  // removed. Does NOT touch the pointer. The `slot` field is a storage-time
  // concern — callers pass nodes/edges without it and the store tags them.
  //
  // `audit` is optional at this interface (the seed script writes without an
  // audit context, and #4's lifecycle tests predate #7). When passed, the
  // backend commits it in the SAME transaction as the final pointer meta
  // touch — see firestore.ts. Every runtime state-changing call goes through
  // runGraphMutation, which always supplies an audit; this parameter is
  // optional here only to keep the seed path untouched.
  writeSlot(namespace: string, slot: Slot, batch: SlotWriteBatch, audit?: AuditRecord): Promise<void>;

  // Set the pointer to publishedSlot if no pointer exists yet; no-op otherwise.
  // Used by the seed script so the first seed also stamps the initial pointer.
  ensurePointer(namespace: string, publishedSlot: Slot): Promise<void>;

  // ── Lifecycle (draft ⇄ published) ─────────────────────────────────────────
  // Every lifecycle op accepts an optional `audit`. When passed, the backend
  // commits the audit doc in the same Firestore transaction that flips the
  // pointer (or in the same synchronous op for the memory backend), so a
  // committed state change always has its record.
  //
  // createDraft: if no draft exists, copy the published slot into the free
  //   slot and set draftSlot in the pointer LAST (so a half-copied draft is
  //   invisible to readers). If a draft already exists, no-op (idempotent).
  //   Errors if the namespace has never been seeded (no pointer).
  createDraft(namespace: string, audit?: AuditRecord): Promise<void>;

  // publishDraft: atomic single-doc pointer flip —
  //   publishedSlot := draftSlot; draftSlot := null.
  // The old published data is orphaned in place until the next createDraft
  // overwrites its slot. Errors if no draft exists.
  publishDraft(namespace: string, audit?: AuditRecord): Promise<void>;

  // discardDraft: single-doc pointer write — draftSlot := null. Orphaned draft
  // docs remain until the next createDraft overwrites them. No-op if no
  // draft exists.
  discardDraft(namespace: string, audit?: AuditRecord): Promise<void>;

  // ── Audit surface (append-only) ────────────────────────────────────────────
  // No update / delete method — records go through `set` on a fresh doc id
  // only. `appendAudit` is used for events that do NOT accompany a state
  // change (blocked attempts); events that DO accompany a state change ride
  // that call's `audit` parameter so both are committed together.
  appendAudit(record: AuditRecord): Promise<void>;
  listAudit(query: AuditQuery): Promise<AuditRecord[]>;
}

// ─── Audit types ─────────────────────────────────────────────────────────────
// Types live here (leaf) so KgNodeStore can reference them without cycling
// through audit.ts. The runtime helpers that operate on records
// (matchesAuditQuery, sortAuditNewestFirst) stay in audit.ts.

export type AuditActor = {
  id: string;
  // `null` — not `undefined` — for missing values. Firestore's default
  // settings reject `undefined` field values on write, so the denial path
  // itself would crash for a no-role/unknown actor. Normalizing here at the
  // source keeps writes serializable and lets audit readers distinguish
  // "field was absent" from a missing key on the doc. The helper
  // `toAuditActor(actor)` in audit.ts is the one place that does the
  // coercion — never build this object inline.
  email: string | null;
  tokenIssuer: string | null;
  /**
   * The actor's LEGACY global role at the time of the event, snapshot from the
   * verified `app_role` JWT claim (see #8). Preserved so an audit review sees
   * WHO WAS a curator/approver when this happened, not who is one now. `null` =
   * no legacy role (a membership-based user, no role, or unknown actor). The
   * per-workspace effective role is derivable from the record's `namespace` +
   * the membership registry; only the legacy claim is snapshot inline.
   */
  role: "curator" | "approver" | "admin" | "super_admin" | null;
  /** Whether the actor was a super admin at the time of the event. */
  superAdmin: boolean;
  unknown: boolean;
};

export type AuditEventType = "apply" | "createDraft" | "publish" | "discard" | "blocked" | "preview" | "read" | "membership" | "workspace";

// One flat shape covers every event type. Fields are populated per event;
// which ones apply is discriminated by `eventType`. Kept flat (rather than a
// discriminated union) so Firestore doc writes and cross-event queries stay
// straightforward — the reader picks the fields it cares about.
export type AuditRecord = {
  id: string;                          // uuid; also the Firestore doc id
  ts: string;                          // ISO-8601 UTC
  actor: AuditActor;
  namespace: string;
  eventType: AuditEventType;

  // Populated per event type:
  mutation?: string;                   // apply | blocked
  baseVersion?: string;                // apply | createDraft | publish | discard
  resultingVersion?: string;           // apply | publish
  diff?: GraphDiff;                    // apply (inline; see #5)
  promotedApplyIds?: string[];         // publish
  discardedApplyIds?: string[];        // discard
  reason?: string;                     // blocked | preview (human descriptor of what was previewed)
  /**
   * publish-only: true if the promoted apply chain contains at least one
   * record authored by the SAME actor doing the publish. Recorded even
   * when `TLM_ALLOW_SELF_APPROVE=1` (the default) so an audit review can
   * still spot self-approval — see #8 decision (b).
   */
  selfAuthored?: boolean;
  /**
   * publish-only (#13): the coverage/consistency warnings present on the draft
   * at publish time (e.g. "chapter has no bilan"). Warnings NEVER block a
   * publish — the approver's call — but recording them here gives the audit
   * trail a note that the approver published despite them. Empty array when
   * the draft was clean; omitted when no coverage hook was available.
   */
  warningsAtPublish?: string[];
  /**
   * read-only (read_audit, #16): a compact JSON string of the filters/mode/
   * cursor the reviewer used. Deliberately NOT a before/after or snapshot —
   * a `read` event exists only to answer "who reviewed the trail, with what
   * query". Kept lightweight so read-events cannot bloat the log; appending
   * one never triggers another read, so growth is linear, never recursive.
   */
  readQuery?: string;
  /** read-only (#16): how many records the read returned. */
  readCount?: number;
};

// Query surface — a minimal internal filter. Not user-facing; #7 does not
// ship an audit browser. Fields compose as an AND.
export type AuditQuery = {
  namespace?: string;
  actorId?: string;
  eventType?: AuditEventType;
  sinceTs?: string;                    // inclusive ISO-8601
  untilTs?: string;                    // inclusive ISO-8601
  limit?: number;                      // default: all matches
};

// ─── Types the graph-mutation framework shares with the validators ───────────
// A mutation reads/writes a graph without the storage-level `slot` tag (the
// store adds that at writeSlot time). Kept here (leaf) so both mutations.ts
// and validate.ts can import them without creating a cycle.
export type MutationNode = Omit<StoredNode, "slot">;
export type MutationEdge = Omit<StoredEdge, "slot">;
export type MutationGraph = { nodes: MutationNode[]; edges: MutationEdge[] };

// Shape returned by every validate function — the framework and the shared
// structural rules alike. `errors` blocks confirmation; `warnings` rides
// alongside a normal preview envelope.
export type ValidationResult = { errors: string[]; warnings: string[] };

// Per-mutation diff (see #5). Lives here rather than in mutations.ts so
// audit.ts can reference the diff shape without importing mutations — that
// would create a cycle through the KgNodeStore interface.
export type DiffEntry = { id: string; before?: unknown; after?: unknown };
export type GraphDiff = {
  nodes: { added: DiffEntry[]; removed: DiffEntry[]; changed: DiffEntry[] };
  edges: { added: DiffEntry[]; removed: DiffEntry[]; changed: DiffEntry[] };
};
