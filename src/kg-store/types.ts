// ── Module: kg-store · internal ──────────────────────────────────────────────
// The generic node/edge store that curriculum + KG read paths hydrate from
// when KG_SOURCE=firestore. Deliberately shape-agnostic: two collections,
// each with an id/type/namespace/slot/properties tuple — no maths-specific
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
};

export type StoredEdge = {
  id: string;                              // stable per (from,to,type,namespace)
  type: string;                            // "hasChild" | "buildsTowards"
  from: string;                            // node id
  to: string;                              // node id
  namespace: string;
  slot: Slot;
  properties: Record<string, unknown>;     // reserved for later steps
};

// Per-namespace provenance stamp. One StoredMeta per (namespace, slot), so a
// published slot and a draft slot can carry independent stamps.
export type StoredMeta = {
  contentHash: string;                     // sha256 hex of the raw KG bundle
  seededAt: string;                        // ISO-8601 UTC
  adapterId: string;                       // e.g. "ci-maths/graph-array-v1"
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

  // ── Wholesale slot write (seed + createDraft's internal copy) ──────────────
  // Idempotent: after this returns, the store's state for (namespace, slot)
  // equals exactly the passed nodes/edges/meta. Stale docs in that slot are
  // removed. Does NOT touch the pointer. The `slot` field is a storage-time
  // concern — callers pass nodes/edges without it and the store tags them.
  writeSlot(namespace: string, slot: Slot, batch: SlotWriteBatch): Promise<void>;

  // Set the pointer to publishedSlot if no pointer exists yet; no-op otherwise.
  // Used by the seed script so the first seed also stamps the initial pointer.
  ensurePointer(namespace: string, publishedSlot: Slot): Promise<void>;

  // ── Lifecycle (draft ⇄ published) ─────────────────────────────────────────
  // createDraft: if no draft exists, copy the published slot into the free
  //   slot and set draftSlot in the pointer LAST (so a half-copied draft is
  //   invisible to readers). If a draft already exists, no-op (idempotent).
  //   Errors if the namespace has never been seeded (no pointer).
  createDraft(namespace: string): Promise<void>;

  // publishDraft: atomic single-doc pointer flip —
  //   publishedSlot := draftSlot; draftSlot := null.
  // The old published data is orphaned in place until the next createDraft
  // overwrites its slot. Errors if no draft exists.
  publishDraft(namespace: string): Promise<void>;

  // discardDraft: single-doc pointer write — draftSlot := null. Orphaned draft
  // docs remain until the next createDraft overwrites them. No-op if no
  // draft exists.
  discardDraft(namespace: string): Promise<void>;
}
