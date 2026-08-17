/*
 * Module: kg-store · internal
 *
 * In-memory KgNodeStore for tests and the parity harness. Mirrors the
 * Firestore backend's canonical-graph + changeset-overlay model so the same
 * lifecycle tests exercise both implementations. No network, no persistence.
 *
 * MODEL (see docs/design-notes/canonical-changeset-store.md):
 *   - The PUBLISHED slot holds the full canonical graph.
 *   - The DRAFT slot holds only an OVERLAY: the nodes/edges an editing session
 *     changed, plus tombstones for ids it deleted. It is NOT a full copy.
 *   - A draft READ (listNodes/listEdges on the draft slot) merges canonical +
 *     overlay − tombstones behind the interface, so callers still see a complete
 *     graph. createDraft is O(1) (no copy); publish applies the overlay onto
 *     canonical. The memory backend is synchronous, so publish is always atomic
 *     regardless of overlay size (the firestore backend size-adapts).
 */
import type { AuditQuery, AuditRecord, KgNodeStore, Slot, StoredConfig, StoredEdge, StoredMeta, StoredNode, StoredPointer } from "./types.js";
import { matchesAuditQuery, sortAuditNewestFirst } from "./audit.js";

// A slot bucket. For the published slot the maps hold the full graph and the
// tombstone sets are empty; for the draft slot the maps hold only the overlay
// and the tombstone sets mark ids the draft deletes from canonical.
type SlotBucket = {
  nodes: Map<string, StoredNode>;
  edges: Map<string, StoredEdge>;
  tombstoneNodes: Set<string>;
  tombstoneEdges: Set<string>;
  meta: StoredMeta | null;
  config: StoredConfig | null;
};
type Namespace = { slots: Record<Slot, SlotBucket>; pointer: StoredPointer | null };

const emptySlot = (): SlotBucket => ({ nodes: new Map(), edges: new Map(), tombstoneNodes: new Set(), tombstoneEdges: new Set(), meta: null, config: null });
const otherSlot = (s: Slot): Slot => (s === "a" ? "b" : "a");

// Merge canonical docs with a draft overlay: overlay entries win by id, tombstones
// remove. Shared by listNodes/listEdges and by publish's in-place apply.
function mergeLayer<T extends { id: string }>(canonical: Map<string, T>, overlay: Map<string, T>, tombstones: Set<string>): T[] {
  const merged = new Map(canonical);
  for (const id of tombstones) merged.delete(id);
  for (const [id, v] of overlay) merged.set(id, v);
  return [...merged.values()];
}

export function createMemoryKgStore(): KgNodeStore {
  const namespaces = new Map<string, Namespace>();
  // One flat log per store instance. Order of insertion is preserved; the
  // list is filtered by matchesAuditQuery on read and sorted newest-first.
  const auditLog: AuditRecord[] = [];
  const ensureNs = (ns: string): Namespace => {
    let n = namespaces.get(ns);
    if (!n) { n = { slots: { a: emptySlot(), b: emptySlot() }, pointer: null }; namespaces.set(ns, n); }
    return n;
  };

  // Is `slot` the open draft for this namespace? Draft reads merge; every other
  // slot read returns its docs directly (canonical, or a seed target).
  const isDraftSlot = (n: Namespace, slot: Slot): boolean => n.pointer?.draftSlot === slot;

  return {
    kind: "memory",

    async listNodes(namespace, slot) {
      const n = ensureNs(namespace);
      if (isDraftSlot(n, slot)) {
        return mergeLayer(n.slots[n.pointer!.publishedSlot].nodes, n.slots[slot].nodes, n.slots[slot].tombstoneNodes);
      }
      return [...n.slots[slot].nodes.values()];
    },
    async listEdges(namespace, slot) {
      const n = ensureNs(namespace);
      if (isDraftSlot(n, slot)) {
        return mergeLayer(n.slots[n.pointer!.publishedSlot].edges, n.slots[slot].edges, n.slots[slot].tombstoneEdges);
      }
      return [...n.slots[slot].edges.values()];
    },
    async readMeta(namespace, slot) { return ensureNs(namespace).slots[slot].meta; },
    async readConfig(namespace, slot) { return ensureNs(namespace).slots[slot].config; },
    async readPointer(namespace) { return ensureNs(namespace).pointer; },

    // Only namespaces that have a pointer — a bare read via ensureNs() lazily
    // creates an empty entry, so filter those out (they were never seeded).
    async listNamespaces() { return [...namespaces.entries()].filter(([, n]) => n.pointer != null).map(([ns]) => ns); },

    async writeSlot(namespace, slot, batch, audit) {
      const n = ensureNs(namespace);
      // Replace-wholesale so a re-write for the same slot converges to identical
      // state — no stale documents left behind. The profile config cell is a
      // SEPARATE concern (writeConfig owns it), so it's preserved across a graph
      // rewrite — mirroring firestore, where writeSlot never touches configA/B.
      n.slots[slot] = {
        nodes: new Map(batch.nodes.map((v) => [v.id, { ...v, namespace, slot }])),
        edges: new Map(batch.edges.map((v) => [v.id, { ...v, namespace, slot }])),
        tombstoneNodes: new Set(),
        tombstoneEdges: new Set(),
        meta: { ...batch.meta },
        config: n.slots[slot].config,
      };
      if (audit) auditLog.push({ ...audit });
    },

    async applyDelta(namespace, slot, delta, meta, audit) {
      // Write the delta onto the slot's OVERLAY (not a full rewrite): upsert the
      // added/changed docs; a removed id becomes a tombstone (canonical may still
      // hold it) AND is dropped from the overlay if it was staged there.
      const bucket = ensureNs(namespace).slots[slot];
      for (const v of delta.upsertNodes) { bucket.nodes.set(v.id, { ...v, namespace, slot }); bucket.tombstoneNodes.delete(v.id); }
      for (const v of delta.upsertEdges) { bucket.edges.set(v.id, { ...v, namespace, slot }); bucket.tombstoneEdges.delete(v.id); }
      for (const id of delta.removeNodeIds) { bucket.nodes.delete(id); bucket.tombstoneNodes.add(id); }
      for (const id of delta.removeEdgeIds) { bucket.edges.delete(id); bucket.tombstoneEdges.add(id); }
      bucket.meta = { ...meta };
      if (audit) auditLog.push({ ...audit });
    },

    async writeConfig(namespace, slot, config, audit) {
      const n = ensureNs(namespace);
      n.slots[slot] = { ...n.slots[slot], config: { ...config } };
      if (audit) auditLog.push({ ...audit });
    },

    async ensurePointer(namespace, publishedSlot) {
      const n = ensureNs(namespace);
      if (!n.pointer) n.pointer = { publishedSlot, draftSlot: null };
    },

    async createDraft(namespace, audit) {
      const n = ensureNs(namespace);
      if (!n.pointer) throw new Error(`createDraft: namespace '${namespace}' has no pointer — it was never seeded.`);
      if (n.pointer.draftSlot) return; // idempotent — a draft already exists
      const from = n.pointer.publishedSlot;
      const to = otherSlot(from);
      // O(1): the draft is an EMPTY overlay on top of published — no graph copy.
      // Only the profile config + meta ride along so the draft opens from the
      // published profile. A draft read merges published + this (empty) overlay,
      // so it reads identical to published until the first edit.
      n.slots[to] = { ...emptySlot(), meta: n.slots[from].meta ? { ...n.slots[from].meta! } : null, config: n.slots[from].config ? { ...n.slots[from].config! } : null };
      n.pointer = { publishedSlot: from, draftSlot: to };
      if (audit) auditLog.push({ ...audit });
    },

    async publishDraft(namespace, audit) {
      const n = ensureNs(namespace);
      if (!n.pointer || !n.pointer.draftSlot) throw new Error(`publishDraft: namespace '${namespace}' has no draft to publish.`);
      const pub = n.pointer.publishedSlot;
      const draft = n.slots[n.pointer.draftSlot];
      const canon = n.slots[pub];
      // Apply the overlay ONTO canonical in place: upsert overlay docs, delete
      // tombstoned ids, promote the draft's meta/config. Published slot does NOT
      // change (a small in-place publish); the firestore backend flips slots only
      // for an over-cap overlay. Atomic here by construction (synchronous).
      for (const id of draft.tombstoneNodes) canon.nodes.delete(id);
      for (const id of draft.tombstoneEdges) canon.edges.delete(id);
      for (const [id, v] of draft.nodes) canon.nodes.set(id, { ...v, slot: pub });
      for (const [id, v] of draft.edges) canon.edges.set(id, { ...v, slot: pub });
      if (draft.meta) canon.meta = { ...draft.meta };
      if (draft.config) canon.config = { ...draft.config };
      n.slots[n.pointer.draftSlot] = emptySlot();
      n.pointer = { publishedSlot: pub, draftSlot: null };
      if (audit) auditLog.push({ ...audit });
    },

    async discardDraft(namespace, audit) {
      const n = ensureNs(namespace);
      if (!n.pointer || !n.pointer.draftSlot) return; // idempotent no-op — no audit either
      n.slots[n.pointer.draftSlot] = emptySlot();
      n.pointer = { publishedSlot: n.pointer.publishedSlot, draftSlot: null };
      if (audit) auditLog.push({ ...audit });
    },

    async appendAudit(record) {
      auditLog.push({ ...record });
    },

    async listAudit(query) {
      return sortAuditNewestFirst(auditLog.filter((r) => matchesAuditQuery(r, query))).slice(0, query.limit ?? Infinity);
    },
  };
}
