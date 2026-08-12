/*
 * Module: curriculum · internal
 *
 * Round-trip between the normalized CurriculumUnit shape (what every read tool
 * consumes) and the generic StoredNode/StoredEdge shape (what the kg-store
 * module holds). Lives here (not in kg-store/) so kg-store stays subject-
 * agnostic — it doesn't know CurriculumModel at all — and so no import cycle
 * forms between curriculum and kg-store.
 */
import { buildModel, unit } from "./model.js";
import type { CurriculumModel, CurriculumUnit, RawGraphSnapshot } from "../types.js";
import type { StoredNode, StoredEdge } from "../kg-store/index.js";
import { edgeId } from "../kg-store/index.js";

// The graph shape the seed / lifecycle produces: no `slot` tag — the store
// stamps that at write time. Reads still return the wire `StoredNode` /
// `StoredEdge` (with slot), which deserializeToModel accepts as a superset.
type LogicalNode = Omit<StoredNode, "slot">;
type LogicalEdge = Omit<StoredEdge, "slot">;

// Session-bag key under which activate.ts stashes the deserialized model when
// KG_SOURCE=firestore. Adapter closures read from this synchronously, so a
// context switch that clears the bag automatically drops the preloaded model.
export const PRELOADED_MODEL_KEY = "curriculum.preloadedModel";

// Deterministic edge id — defined in the kg-store leaf (kg-store/types.ts) so
// the store's structural linker and this serializer share ONE definition
// without cycling. Re-exported here to keep curriculum's public surface stable
// (curriculum/index.ts re-exports it from this module).
export { edgeId };

const numeric = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export type SerializedGraph = { nodes: LogicalNode[]; edges: LogicalEdge[] };

// Encode a parsed CurriculumModel as generic nodes + edges.
//
// FULL-GRAPH mode (when the model carries `rawGraph`, i.e. it came from
// parseGraph): store EVERY raw node and EVERY raw edge verbatim, so the store is
// a faithful, re-exportable Learning-Commons copy. Spine nodes (the ones parse
// kept) also carry their normalized fields + `spine:true`; non-spine nodes carry
// only `raw` + `spine:false`. Edges keep their real LC type (hasChild/supports/
// relatesTo/buildsTowards) and a `seq` = original position, which hydration
// replays through the parser to reproduce the spine exactly.
//
// LEGACY spine-only mode (no `rawGraph`, e.g. an in-memory model hand-built from
// unit()): the previous behavior — spine nodes + hasChild/buildsTowards derived
// from childIds/buildsTowards. Kept so callers that never had a raw graph still
// round-trip.
export function serializeModel(model: CurriculumModel, namespace: string): SerializedGraph {
  return model.rawGraph
    ? serializeFullGraph(model, model.rawGraph, namespace)
    : serializeSpineOnly(model, namespace);
}

function serializeFullGraph(model: CurriculumModel, raw: RawGraphSnapshot, namespace: string): SerializedGraph {
  const nodes: LogicalNode[] = raw.nodes.map((n) => {
    const u = model.byId.get(n.id);
    if (u) {
      // Spine node — normalized fields alongside the raw passthrough.
      return {
        id: u.id, type: u.kind, namespace, labels: u.labels ?? n.labels ?? [], spine: true,
        properties: { code: u.code, title: u.title, text: u.text, order: u.order, isAssessment: u.isAssessment, raw: u.properties ?? n.properties ?? {} },
      };
    }
    // Non-spine node — kept only for faithful re-export; `type` is its raw first
    // label so the explorer can categorise it, and there are no normalized fields.
    return {
      id: n.id, type: n.labels?.[0] ?? "lc-node", namespace, labels: n.labels ?? [], spine: false,
      properties: { raw: n.properties ?? {} },
    };
  });

  // Every raw edge, verbatim type. The stored id stays deterministic
  // (edgeId(type,from,to)) so the structural mutations can find/dedup it; the
  // original LC edge id survives inside `properties.identifier` for re-export.
  // `seq` preserves raw order — hydration sorts by it before re-parsing.
  const edges: LogicalEdge[] = [];
  const seen = new Set<string>();
  raw.relationships.forEach((r, i) => {
    let id = edgeId(r.type, r.start, r.end);
    if (seen.has(id)) id = `${id}#${i}`;   // guard the (rare) duplicate (type,from,to); keeps edge count faithful
    seen.add(id);
    edges.push({ id, type: r.type, from: r.start, to: r.end, namespace, properties: r.properties ?? {}, seq: i });
  });

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}

function serializeSpineOnly(model: CurriculumModel, namespace: string): SerializedGraph {
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
      labels: u.labels ?? [],
      spine: true,
    });
  }
  for (const u of model.byId.values()) {
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

// Rebuild the raw Learning-Commons envelope ({ nodes, relationships }) from
// stored nodes + edges. This is the inverse of serializeFullGraph: the store IS
// the raw graph, so hydration hands this straight to `adapter.parse` (which
// re-derives the spine exactly), and a re-export writes it back out as LC JSON.
// Node raw props come from `properties.raw`; the original LC edge id is restored
// from `properties.identifier`; edges are replayed in their stored `seq` order.
export function toRawEnvelope(input: { nodes: LogicalNode[]; edges: LogicalEdge[] }): RawGraphSnapshot {
  const nodes = input.nodes.map((n) => ({
    id: n.id,
    labels: n.labels ?? [],
    properties: (n.properties.raw as Record<string, unknown>) ?? {},
  }));
  const relationships = [...input.edges]
    .sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))
    .map((e) => ({
      id: (e.properties?.identifier as string) ?? e.id,
      type: e.type,
      start: e.from,
      end: e.to,
      properties: e.properties ?? {},
    }));
  return { nodes, relationships };
}

// Rebuild a CurriculumModel from stored nodes + edges. Fields in
// StoredNode.properties round-trip exactly: `raw` restores the subject-specific
// passthrough dict, and code/title/text/order/isAssessment restore the
// normalized fields — so downstream presenters see a byte-identical model.
// NOTE: reads now hydrate via `adapter.parse(toRawEnvelope(...))` (which honours
// the full graph); this spine-only rebuild is retained for tests/tools that
// round-trip a spine model directly.
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
      labels: n.labels ?? [],
    }),
  );

  return buildModel(units);
}
