// ── Module: kg-store · internal ──────────────────────────────────────────────
// In-memory KgNodeStore for tests and the parity harness. Mirrors the
// Firestore backend's slot + pointer model so the same lifecycle tests
// exercise both implementations. No network, no persistence.
import type { KgNodeStore, Slot, StoredEdge, StoredMeta, StoredNode, StoredPointer } from "./types.js";
import { otherSlot } from "./types.js";

type SlotBucket = { nodes: Map<string, StoredNode>; edges: Map<string, StoredEdge>; meta: StoredMeta | null };
type Namespace = { slots: Record<Slot, SlotBucket>; pointer: StoredPointer | null };

const emptySlot = (): SlotBucket => ({ nodes: new Map(), edges: new Map(), meta: null });

export function createMemoryKgStore(): KgNodeStore {
  const namespaces = new Map<string, Namespace>();
  const ensureNs = (ns: string): Namespace => {
    let n = namespaces.get(ns);
    if (!n) { n = { slots: { a: emptySlot(), b: emptySlot() }, pointer: null }; namespaces.set(ns, n); }
    return n;
  };

  return {
    kind: "memory",

    async listNodes(namespace, slot) { return [...ensureNs(namespace).slots[slot].nodes.values()]; },
    async listEdges(namespace, slot) { return [...ensureNs(namespace).slots[slot].edges.values()]; },
    async readMeta(namespace, slot) { return ensureNs(namespace).slots[slot].meta; },
    async readPointer(namespace) { return ensureNs(namespace).pointer; },

    async writeSlot(namespace, slot, batch) {
      const n = ensureNs(namespace);
      // Replace-wholesale so a re-write for the same slot converges to identical
      // state — no stale documents left behind.
      n.slots[slot] = {
        nodes: new Map(batch.nodes.map((v) => [v.id, { ...v, namespace, slot }])),
        edges: new Map(batch.edges.map((v) => [v.id, { ...v, namespace, slot }])),
        meta: { ...batch.meta },
      };
    },

    async ensurePointer(namespace, publishedSlot) {
      const n = ensureNs(namespace);
      if (!n.pointer) n.pointer = { publishedSlot, draftSlot: null };
    },

    async createDraft(namespace) {
      const n = ensureNs(namespace);
      if (!n.pointer) throw new Error(`createDraft: namespace '${namespace}' has no pointer — it was never seeded.`);
      // Idempotent: a draft already exists, so nothing to do.
      if (n.pointer.draftSlot) return;
      const from = n.pointer.publishedSlot;
      const to = otherSlot(from);
      const source = n.slots[from];
      // Byte-for-byte clone; ids preserved verbatim. Slot rewritten to the
      // destination so the copies are queryable under the draft slot.
      n.slots[to] = {
        nodes: new Map([...source.nodes.entries()].map(([id, v]) => [id, { ...v, slot: to }])),
        edges: new Map([...source.edges.entries()].map(([id, v]) => [id, { ...v, slot: to }])),
        meta: source.meta ? { ...source.meta } : null,
      };
      // Pointer is set LAST so a mid-copy failure (irrelevant here but the
      // firestore backend depends on this ordering) leaves the draft invisible.
      n.pointer = { publishedSlot: from, draftSlot: to };
    },

    async publishDraft(namespace) {
      const n = ensureNs(namespace);
      if (!n.pointer || !n.pointer.draftSlot) throw new Error(`publishDraft: namespace '${namespace}' has no draft to publish.`);
      // Atomic single-doc pointer flip. Old published data stays in place;
      // the next createDraft will overwrite it wholesale.
      n.pointer = { publishedSlot: n.pointer.draftSlot, draftSlot: null };
    },

    async discardDraft(namespace) {
      const n = ensureNs(namespace);
      if (!n.pointer || !n.pointer.draftSlot) return; // idempotent no-op
      n.pointer = { publishedSlot: n.pointer.publishedSlot, draftSlot: null };
    },
  };
}
