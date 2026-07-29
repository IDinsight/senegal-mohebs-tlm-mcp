// ── Module: curriculum · internal ────────────────────────────────────────────
// Round-trip between the normalized CurriculumUnit shape (what every read tool
// consumes) and the generic StoredNode/StoredEdge shape (what the kg-store
// module holds). Lives here (not in kg-store/) so kg-store stays subject-
// agnostic — it doesn't know CurriculumModel at all — and so no import cycle
// forms between curriculum and kg-store.
import { buildModel, unit } from "./model.js";
import type { CurriculumModel, CurriculumUnit } from "../types.js";
import type { StoredNode, StoredEdge } from "../kg-store/index.js";

// The graph shape the seed / lifecycle produces: no `slot` tag — the store
// stamps that at write time. Reads still return the wire `StoredNode` /
// `StoredEdge` (with slot), which deserializeToModel accepts as a superset.
type LogicalNode = Omit<StoredNode, "slot">;
type LogicalEdge = Omit<StoredEdge, "slot">;

// Session-bag key under which activate.ts stashes the deserialized model when
// KG_SOURCE=firestore. Adapter closures read from this synchronously, so a
// context switch that clears the bag automatically drops the preloaded model.
export const PRELOADED_MODEL_KEY = "curriculum.preloadedModel";

// Deterministic edge id — same input always produces the same id, so a re-seed
// overwrites the same document instead of appending a new one.
export const edgeId = (type: string, from: string, to: string) => `${type}:${from}->${to}`;

const numeric = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export type SerializedGraph = { nodes: LogicalNode[]; edges: LogicalEdge[] };

// Encode a parsed CurriculumModel as generic nodes + edges. All CurriculumUnit
// fields land in `properties`; parentId/childIds/buildsFrom/buildsTowards are
// externalized as edges and NOT redundantly copied into properties (they are
// re-derived from the edges on the way back).
export function serializeModel(model: CurriculumModel, namespace: string): SerializedGraph {
  const nodes: LogicalNode[] = [];
  const edges: LogicalEdge[] = [];
  const seen = new Set<string>();
  for (const u of model.byId.values()) {
    nodes.push({
      id: u.id,
      type: u.kind,
      namespace,
      properties: {
        code: u.code,
        title: u.title,
        text: u.text,
        order: u.order,
        isAssessment: u.isAssessment,
        raw: u.properties ?? {},
      },
    });
  }
  for (const u of model.byId.values()) {
    // The adapter's childIds order is meaningful — presenters render children in
    // that order and the parity oracle compares those outputs — so we record
    // it explicitly instead of relying on Firestore's non-guaranteed doc order.
    u.childIds.forEach((childId, i) => {
      if (!model.byId.has(childId)) return;
      const id = edgeId("hasChild", u.id, childId);
      if (seen.has(id)) return;
      seen.add(id);
      edges.push({ id, type: "hasChild", from: u.id, to: childId, namespace, properties: { orderInParent: i } });
    });
    u.buildsTowards.forEach((towardId, i) => {
      const target = model.byId.get(towardId);
      if (!target) return;
      const id = edgeId("buildsTowards", u.id, towardId);
      if (seen.has(id)) return;
      seen.add(id);
      // Both ends carry order: the adapter observes buildsTowards[from] and
      // buildsFrom[to] independently (they follow raw file order, which may
      // differ from any per-node ordering). Recording both makes the inverse
      // list (buildsFrom) as byte-stable as the direct list (buildsTowards).
      const sequenceInTo = target.buildsFrom.indexOf(u.id);
      edges.push({
        id, type: "buildsTowards", from: u.id, to: towardId, namespace,
        properties: { sequenceInFrom: i, sequenceInTo: sequenceInTo < 0 ? i : sequenceInTo },
      });
    });
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}

// Rebuild a CurriculumModel from stored nodes + edges. Fields in
// StoredNode.properties round-trip exactly: `raw` restores the subject-specific
// passthrough dict, and code/title/text/order/isAssessment restore the
// normalized fields — so downstream presenters see a byte-identical model.
export function deserializeToModel(input: { nodes: LogicalNode[]; edges: LogicalEdge[] }): CurriculumModel {
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const childBuckets = new Map<string, { order: number; to: string }[]>();
  const buildsTowardsBuckets = new Map<string, { order: number; to: string }[]>();
  const buildsFromBuckets = new Map<string, { order: number; to: string }[]>();
  const parentBy = new Map<string, string>();

  for (const e of input.edges) {
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
    if (e.type === "hasChild") {
      const bucket = childBuckets.get(e.from) ?? childBuckets.set(e.from, []).get(e.from)!;
      bucket.push({ order: numeric(e.properties.orderInParent, bucket.length), to: e.to });
      parentBy.set(e.to, e.from);
    } else if (e.type === "buildsTowards") {
      const bucket = buildsTowardsBuckets.get(e.from) ?? buildsTowardsBuckets.set(e.from, []).get(e.from)!;
      bucket.push({ order: numeric(e.properties.sequenceInFrom, bucket.length), to: e.to });
      const inv = buildsFromBuckets.get(e.to) ?? buildsFromBuckets.set(e.to, []).get(e.to)!;
      inv.push({ order: numeric(e.properties.sequenceInTo, inv.length), to: e.from });
    }
    // Unknown edge types are silently ignored — kept for forward compatibility.
  }
  const childByParent = new Map<string, string[]>();
  for (const [k, v] of childBuckets) childByParent.set(k, v.sort((a, b) => a.order - b.order).map((x) => x.to));
  const buildsTowardsBy = new Map<string, string[]>();
  const buildsFromBy = new Map<string, string[]>();
  for (const [k, v] of buildsTowardsBuckets)
    buildsTowardsBy.set(k, v.sort((a, b) => a.order - b.order).map((x) => x.to));
  for (const [k, v] of buildsFromBuckets)
    buildsFromBy.set(k, v.sort((a, b) => a.order - b.order).map((x) => x.to));

  const units: CurriculumUnit[] = input.nodes.map((n) =>
    unit({
      id: n.id,
      kind: n.type,
      code: (n.properties.code as string | null) ?? null,
      title: (n.properties.title as string | null) ?? null,
      text: (n.properties.text as string | null) ?? null,
      order: (n.properties.order as number | null) ?? null,
      parentId: parentBy.get(n.id) ?? null,
      childIds: childByParent.get(n.id) ?? [],
      buildsTowards: buildsTowardsBy.get(n.id) ?? [],
      buildsFrom: buildsFromBy.get(n.id) ?? [],
      isAssessment: Boolean(n.properties.isAssessment),
      properties: (n.properties.raw as Record<string, unknown>) ?? {},
    }),
  );

  return buildModel(units);
}
