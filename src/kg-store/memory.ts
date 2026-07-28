// ── Module: kg-store · internal ──────────────────────────────────────────────
// In-memory KgNodeStore for tests and the parity harness. Same interface as the
// Firestore backend, no network. Keyed by namespace so parity across multiple
// grade/subject pairs can be exercised inside one process.
import type { KgNodeStore, StoredEdge, StoredMeta, StoredNode } from "./types.js";

type Bucket = { nodes: Map<string, StoredNode>; edges: Map<string, StoredEdge>; meta: StoredMeta | null };

export function createMemoryKgStore(): KgNodeStore {
  const buckets = new Map<string, Bucket>();
  const ensure = (ns: string): Bucket => {
    let b = buckets.get(ns);
    if (!b) { b = { nodes: new Map(), edges: new Map(), meta: null }; buckets.set(ns, b); }
    return b;
  };
  return {
    kind: "memory",
    async listNodes(namespace) { return [...ensure(namespace).nodes.values()]; },
    async listEdges(namespace) { return [...ensure(namespace).edges.values()]; },
    async readMeta(namespace) { return ensure(namespace).meta; },
    async writeNamespace(namespace, batch) {
      const b = ensure(namespace);
      // Replace-wholesale: same semantics as the Firestore backend so a re-seed
      // converges to identical state and stale docs never accumulate.
      b.nodes = new Map(batch.nodes.map((n) => [n.id, { ...n, namespace }]));
      b.edges = new Map(batch.edges.map((e) => [e.id, { ...e, namespace }]));
      b.meta = { ...batch.meta };
    },
  };
}
