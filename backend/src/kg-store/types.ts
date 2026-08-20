// ── Module: kg-store · internal ──────────────────────────────────────────────
// The generic node/edge store that curriculum + KG read paths hydrate from — the
// single source of truth for the graph. Deliberately shape-agnostic: two
// collections, each with an id/type/namespace/slot/properties tuple — no
// CI-maths-specific fields bake into storage.
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

// The subject-profile config, stored beside the graph as OPAQUE JSON. kg-store
// is subject-agnostic — it never parses or validates this; the profile schema
// lives in the adapters layer (SubjectProfile), and validation is injected at
// authoring time (see config-flow.ts). One StoredConfig per (namespace, slot),
// so a draft can carry a proposed profile independent of the published one; the
// cell rides the SAME pointer as the graph (copied on createDraft, cleared on
// discardDraft, promoted by the publish flip) — see docs/design-notes/authorable-catalog.md
// phase 2b.
export type StoredConfig = Record<string, unknown>;

// A staged confirm payload, parked between a two-phase op's dry-run and its
// confirm and keyed by the token's one-time nonce. This exists so a LARGE
// payload (a whole profile record, a content-heavy authoring batch) does not
// have to be RE-SENT verbatim on confirm — the model would pay to regenerate it
// and could reproduce it imperfectly (→ args-hash mismatch). Instead the dry-run
// parks it here and the confirm reads it back by nonce. Small payloads skip this
// entirely and keep the re-send path (see the size trigger in mutations.ts).
//
// Integrity is still pinned: `proposedHash` (sha256 of the payload) lets confirm
// prove the parked bytes are the ones the token was issued for. `expiresAt` is a
// timing bound — a confirm that arrives after it treats the entry as absent, the
// same as if it had never been parked. NOT a correctness guard: exactly-once and
// "nothing moved since dry-run" are still enforced by the nonce ledger + the base
// hash-CAS, so a lost/expired entry can only ever force a fresh dry-run, never a
// double-apply. The entry is deleted best-effort after a successful apply.
export type PendingEntry = {
  op: string;              // mutation name / "editProfile" — cross-checked against the token
  proposedHash: string;    // sha256 of `payload` — the integrity pin
  payload: unknown;        // the staged args the confirm would otherwise re-send
  expiresAt: number;       // epoch ms; a read past this treats the entry as absent
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

// The canonical Learning-Commons relationship vocabulary — every edge type the
// ontology defines (see docs/reference/learning-commons/relationships.md). It is
// the FLOOR for link_nodes' known-edge-type gate: an edge type is creatable when
// it is canonical OR already present in the namespace. Without this, a namespace
// could never create the FIRST edge of a type it doesn't yet have (e.g. reading
// had zero `usesRoutine` edges, so `usesRoutine` was rejected there while
// ci/maths accepted it). The gate still rejects invented types like "hasLesson".
export const CANONICAL_EDGE_TYPES: ReadonlySet<string> = new Set([
  "hasChild",                 // standards tree: SFI parent → child
  "hasPart",                  // content tree: compositional nesting
  "supports",                 // LearningComponent → SFI
  "hasEducationalAlignment",  // content → SFI (the only content→standards bridge)
  "relatesTo",                // SFI ↔ SFI, non-directional
  "buildsTowards",            // SFI → SFI, directional progression
  "hasDependency",            // content → content prerequisite
  "usesRoutine",              // Course/Lesson/Activity → InstructionalRoutine
]);

// Input shape for writeSlot. `slot` is added by the store at write time — the
// caller passes the logical graph, not the wire representation.
export type SlotWriteBatch = {
  nodes: Array<Omit<StoredNode, "slot">>;
  edges: Array<Omit<StoredEdge, "slot">>;
  meta: StoredMeta;
};

// Input shape for applyDelta — the EDIT hot path's write. Carries only what
// changed: docs to upsert (added + changed) and ids to remove. This is what
// lets an N-node edit cost O(N) writes instead of rewriting the whole slot.
export type SlotDelta = {
  upsertNodes: Array<Omit<StoredNode, "slot">>;
  upsertEdges: Array<Omit<StoredEdge, "slot">>;
  removeNodeIds: string[];
  removeEdgeIds: string[];
};

export interface KgNodeStore {
  readonly kind: "firestore" | "memory";

  // ── Reads (slot-scoped) ────────────────────────────────────────────────────
  // Callers resolve slot via readPointer() first; this interface deliberately
  // takes an explicit slot so no ambient state can leak the "wrong" version.
  listNodes(namespace: string, slot: Slot): Promise<StoredNode[]>;
  listEdges(namespace: string, slot: Slot): Promise<StoredEdge[]>;
  readMeta(namespace: string, slot: Slot): Promise<StoredMeta | null>;
  readConfig(namespace: string, slot: Slot): Promise<StoredConfig | null>;
  readPointer(namespace: string): Promise<StoredPointer | null>;

  // Every namespace that has a pointer (i.e. has been seeded/imported). The
  // store is the source of truth for WHICH graphs exist — context discovery
  // enumerates these instead of scanning on-disk source folders. Includes the
  // reserved catalog partitions (`…/_catalog/routines`); the caller filters.
  listNamespaces(): Promise<string[]>;

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

  // ── Delta slot write (the EDIT hot path) ──────────────────────────────────
  // Apply a precomputed delta to a slot: upsert the added/changed docs, delete
  // the removed ids, stamp `meta`. Unlike writeSlot it does NOT read or rewrite
  // the whole slot, so an N-node edit costs O(N) writes rather than O(graph) —
  // this is the fix for the full-graph rewrite on every mutation.
  //
  // CORRECTNESS: the caller must have computed `delta` against exactly the
  // slot's current contents. runGraphMutation guarantees this via its
  // base-version hash-CAS (the token's `v` must still match the slot before a
  // confirm applies). Idempotent for a fixed delta — upserts are `set`, removes
  // are `delete`, both replayable. Commits `meta` + optional `audit` in the
  // same final transaction as writeSlot does, so a committed edit always has
  // its record.
  applyDelta(namespace: string, slot: Slot, delta: SlotDelta, meta: StoredMeta, audit?: AuditRecord): Promise<void>;

  // Write the subject-profile config cell for one (namespace, slot). Independent
  // of writeSlot — the profile is edited on its own cadence (edit_profile), not
  // on every graph write. Like writeSlot's final meta touch, `audit` (when
  // passed) is committed in the SAME transaction as the config write. The seed
  // writes the published cell without an audit; edit_profile writes the draft
  // cell with one.
  writeConfig(namespace: string, slot: Slot, config: StoredConfig, audit?: AuditRecord): Promise<void>;

  // Set the pointer to publishedSlot if no pointer exists yet; no-op otherwise.
  // Used by the seed script so the first seed also stamps the initial pointer.
  ensurePointer(namespace: string, publishedSlot: Slot): Promise<void>;

  // ── Lifecycle (draft ⇄ published) ─────────────────────────────────────────
  // Every lifecycle op accepts an optional `audit`. When passed, the backend
  // commits the audit doc in the same Firestore transaction that flips the
  // pointer (or in the same synchronous op for the memory backend), so a
  // committed state change always has its record.
  //
  // createDraft: open a draft as an EMPTY OVERLAY on top of published — O(1), no
  //   graph copy (canonical + changeset model; see the design note). Sets
  //   draftSlot in the pointer and carries the published profile CONFIG + meta
  //   cell so the draft opens from the published profile. A draft read merges
  //   published + this (empty) overlay, reading identical to published until the
  //   first edit. If a draft already exists, no-op (idempotent). Errors if the
  //   namespace has never been seeded (no pointer).
  createDraft(namespace: string, audit?: AuditRecord): Promise<void>;

  // publishDraft: apply the draft's overlay onto the canonical (published) graph,
  //   then clear the draft. ALWAYS ATOMIC — a small overlay applies in one
  //   transaction in place (published slot unchanged); an over-cap overlay
  //   materializes into the draft slot and atomically swaps it in as the new
  //   published slot. Either way no reader observes a partial published graph.
  //   Errors if no draft exists.
  publishDraft(namespace: string, audit?: AuditRecord): Promise<void>;

  // discardDraft: delete the draft's overlay docs and clear the pointer's draft
  //   state + meta/config cells (so a fresh createDraft doesn't inherit a stale
  //   profile). Published is untouched. No-op if no draft exists.
  discardDraft(namespace: string, audit?: AuditRecord): Promise<void>;

  // ── Audit surface (append-only) ────────────────────────────────────────────
  // No update / delete method — records go through `set` on a fresh doc id
  // only. `appendAudit` is used for events that do NOT accompany a state
  // change (blocked attempts); events that DO accompany a state change ride
  // that call's `audit` parameter so both are committed together.
  appendAudit(record: AuditRecord): Promise<void>;
  listAudit(query: AuditQuery): Promise<AuditRecord[]>;

  // ── Pending confirm payloads (token-only confirm for large payloads) ───────
  // Park a payload at dry-run so the confirm need not re-send it; read it back
  // by the token's nonce at confirm; delete it after a successful apply. These
  // are pure payload storage — NOT a lock and NOT the source of exactly-once
  // (that stays the nonce ledger + base hash-CAS). readPending returns null for
  // an absent OR expired entry; the caller treats null as "re-preview". Keyed by
  // (namespace, nonce). See PendingEntry.
  putPending(namespace: string, nonce: string, entry: PendingEntry): Promise<void>;
  readPending(namespace: string, nonce: string): Promise<PendingEntry | null>;
  deletePending(namespace: string, nonce: string): Promise<void>;
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
