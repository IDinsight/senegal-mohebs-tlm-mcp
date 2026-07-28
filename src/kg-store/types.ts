// ── Module: kg-store · internal ──────────────────────────────────────────────
// The generic node/edge store that curriculum + KG read paths hydrate from
// when KG_SOURCE=firestore. Deliberately shape-agnostic: two collections,
// each with an id/type/namespace/properties tuple — no maths-specific fields
// bake into storage. Later steps (declarative schema, write tools) live on
// top of this shape without changing it.

export type StoredNode = {
  id: string;                              // verbatim from the raw graph
  type: string;                            // CurriculumUnit.kind — "chapter","lesson",…
  namespace: string;                       // "${basePrefix}<grade>/<subject>"
  properties: Record<string, unknown>;     // normalized fields + raw passthrough
};

export type StoredEdge = {
  id: string;                              // stable per (from,to,type,namespace)
  type: string;                            // "hasChild" | "buildsTowards"
  from: string;                            // node id
  to: string;                              // node id
  namespace: string;
  properties: Record<string, unknown>;     // reserved for later steps
};

// Per-namespace provenance stamp. Kept intentionally small: content hash of the
// seed input, wall-clock time, and the adapter that produced it. Full
// version-pinning is a later step; this only makes the seed traceable.
export type StoredMeta = {
  contentHash: string;                     // sha256 hex of the raw KG bundle
  seededAt: string;                        // ISO-8601 UTC
  adapterId: string;                       // e.g. "ci-maths/graph-array-v1"
  nodeCount: number;
  edgeCount: number;
};

export interface KgNodeStore {
  readonly kind: "firestore" | "memory";
  listNodes(namespace: string): Promise<StoredNode[]>;
  listEdges(namespace: string): Promise<StoredEdge[]>;
  readMeta(namespace: string): Promise<StoredMeta | null>;
  // Idempotent write: after this returns, the store's state for `namespace`
  // equals exactly the passed nodes/edges/meta. Re-running with the same
  // input yields the same state (no duplicates, no stragglers).
  writeNamespace(namespace: string, batch: { nodes: StoredNode[]; edges: StoredEdge[]; meta: StoredMeta }): Promise<void>;
}
