// ── Module: kg-store · internal ──────────────────────────────────────────────
// In-memory KgNodeStore for tests and the parity harness. Mirrors the
// Firestore backend's slot + pointer model so the same lifecycle tests
// exercise both implementations. No network, no persistence.
import type { AuditQuery, AuditRecord, KgNodeStore, Slot, StoredEdge, StoredMeta, StoredNode, StoredPointer } from "./types.js";
import { otherSlot } from "./types.js";
import { matchesAuditQuery, sortAuditNewestFirst } from "./audit.js";

type SlotBucket = { nodes: Map<string, StoredNode>; edges: Map<string, StoredEdge>; meta: StoredMeta | null };
type Namespace = { slots: Record<Slot, SlotBucket>; pointer: StoredPointer | null };

const emptySlot = (): SlotBucket => ({ nodes: new Map(), edges: new Map(), meta: null });

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

  return {
    kind: "memory",

    async listNodes(namespace, slot) { return [...ensureNs(namespace).slots[slot].nodes.values()]; },
    async listEdges(namespace, slot) { return [...ensureNs(namespace).slots[slot].edges.values()]; },
    async readMeta(namespace, slot) { return ensureNs(namespace).slots[slot].meta; },
    async readPointer(namespace) { return ensureNs(namespace).pointer; },

    async writeSlot(namespace, slot, batch, audit) {
      const n = ensureNs(namespace);
      // Replace-wholesale so a re-write for the same slot converges to identical
      // state — no stale documents left behind.
      n.slots[slot] = {
        nodes: new Map(batch.nodes.map((v) => [v.id, { ...v, namespace, slot }])),
        edges: new Map(batch.edges.map((v) => [v.id, { ...v, namespace, slot }])),
        meta: { ...batch.meta },
      };
      // Atomic in the memory backend: the state write above and the audit push
      // below share a single synchronous block — no interleaving is possible.
      if (audit) auditLog.push({ ...audit });
    },

    async ensurePointer(namespace, publishedSlot) {
      const n = ensureNs(namespace);
      if (!n.pointer) n.pointer = { publishedSlot, draftSlot: null };
    },

    async createDraft(namespace, audit) {
      const n = ensureNs(namespace);
      if (!n.pointer) throw new Error(`createDraft: namespace '${namespace}' has no pointer — it was never seeded.`);
      // Idempotent: a draft already exists, so nothing to do (and no audit).
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
      if (audit) auditLog.push({ ...audit });
    },

    async publishDraft(namespace, audit) {
      const n = ensureNs(namespace);
      if (!n.pointer || !n.pointer.draftSlot) throw new Error(`publishDraft: namespace '${namespace}' has no draft to publish.`);
      // Atomic single-doc pointer flip. Old published data stays in place;
      // the next createDraft will overwrite it wholesale.
      n.pointer = { publishedSlot: n.pointer.draftSlot, draftSlot: null };
      if (audit) auditLog.push({ ...audit });
    },

    async discardDraft(namespace, audit) {
      const n = ensureNs(namespace);
      if (!n.pointer || !n.pointer.draftSlot) return; // idempotent no-op — no audit either
      n.pointer = { publishedSlot: n.pointer.publishedSlot, draftSlot: null };
      if (audit) auditLog.push({ ...audit });
    },

    async appendAudit(record) {
      // Append-only: no code path removes or updates records. The write is a
      // pure push, and only the read side (listAudit) exposes them again.
      auditLog.push({ ...record });
    },

    async listAudit(query) {
      return sortAuditNewestFirst(auditLog.filter((r) => matchesAuditQuery(r, query))).slice(0, query.limit ?? Infinity);
    },
  };
}
