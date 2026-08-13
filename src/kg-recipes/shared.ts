/*
 * kg-recipes · internal toolkit
 *
 * The subject-agnostic helpers the four verbs share: a single POSITION concept,
 * containment/parent lookups over any edge, and the created-node property
 * builder. Titles and ordinals are written straight to their canonical LC paths —
 * no wording/structural aliases here (only `upsert_property` still uses those).
 */

import { readAtPath, writeAtPath, type MutationGraph, type MutationNode } from "../kg-store/index.js";
import { POSITION, orderPathsOf, type NodeTemplate } from "./lc.js";

export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const nodeById = (g: MutationGraph, id: string): MutationNode | undefined => g.nodes.find((n) => n.id === id);

// The children of `parentId` reachable via `edge` — the id-based containment
// backbone, subject-agnostic (works for hasPart, hasChild, supports alike).
export function childrenVia(g: MutationGraph, parentId: string, edge: string): MutationNode[] {
  const out: MutationNode[] = [];
  for (const e of g.edges) {
    if (e.type !== edge || e.from !== parentId) continue;
    const child = nodeById(g, e.to);
    if (child) out.push(child);
  }
  return out;
}

// The containment edges pointing AT a node (its parents on `edge`). Normally one;
// more than one is a legitimate multi-axis state (a maths lesson under both a
// grouping and a week). move_node detaches all of a given edge before relinking.
export function parentEdgeIds(g: MutationGraph, childId: string, edge: string): string[] {
  return g.edges.filter((e) => e.type === edge && e.to === childId).map((e) => e.id);
}

// A node's POSITION — the single ordinal concept (the normalized top-level
// `order`, mirrored into raw at a source-specific path the template knows).
export const positionOf = (n: MutationNode): number => asNum(readAtPath(n.properties, POSITION)) ?? 0;

// The next free position when appending under `parentId` on `edge`: max sibling
// position + 1 (1 when empty). Subject-agnostic — every kind orders the same way.
export function nextPosition(g: MutationGraph, parentId: string, edge: string): number {
  let max = 0;
  for (const c of childrenVia(g, parentId, edge)) max = Math.max(max, positionOf(c));
  return max + 1;
}

// Immutably write `value` at `path` unless it is undefined (Firestore rejects
// `undefined`, so an absent optional must leave no key behind).
const put = (props: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> =>
  value === undefined ? props : writeAtPath(props, path, value);

// Build a created node's full `properties`: normalized fields (title/text, order,
// isAssessment) alongside the `raw` passthrough. `extraRaw` holds any extra
// canonical LC props the caller supplied (studentGroupingType, materialType,
// content, …), each written under `raw.*`. Raw carries the node's identity and
// ordinal, so it re-parses faithfully.
export function buildCreatedProps(
  t: NodeTemplate,
  opts: { id?: string; title?: string; title_en?: string; position: number; isAssessment: boolean; extraRaw?: Record<string, unknown> },
): Record<string, unknown> {
  let props: Record<string, unknown> = { raw: {} };
  // Normalized (top-level) fields the store keeps alongside raw.
  props = put(props, t.isGrouping ? "title" : "text", opts.title);
  props = put(props, POSITION, opts.position);
  if (opts.isAssessment) props = put(props, "isAssessment", true);
  // Raw passthrough — what the parser reads on re-hydration. Boilerplate first
  // (license/provider/… copied from a sibling), so any author-supplied extraRaw
  // key can still override it.
  for (const [k, v] of Object.entries(t.boilerplate)) props = put(props, `raw.${k}`, v);
  props = put(props, "raw.identifier", opts.id);
  props = put(props, "raw.description", opts.title);
  props = put(props, "raw.metadata.en.description", opts.title_en);
  for (const p of t.orderPaths) props = put(props, p, opts.position);
  props = put(props, "raw.normalizedType", t.normalizedType);
  props = put(props, "raw.normalizedStatementType", t.normalizedStatementType);
  props = put(props, "raw.metadata.role", t.role);
  for (const [k, v] of Object.entries(opts.extraRaw ?? {})) props = put(props, `raw.${k}`, v);
  return props;
}

// Set a node's POSITION — the single ordinal — writing BOTH the normalized
// top-level `order` and the node's own raw mirror path (so it round-trips at the
// source's convention). Immutable; used by move_node and reposition.
export function setPosition(nodes: MutationNode[], nodeId: string, position: number): MutationNode[] {
  return nodes.map((n) => {
    if (n.id !== nodeId) return n;
    let props = writeAtPath(n.properties, POSITION, position);
    const paths = orderPathsOf(n);
    for (const p of (paths.length ? paths : ["raw.position"])) props = writeAtPath(props, p, position);
    return { ...n, properties: props };
  });
}

// The one non-canonical-but-LC content path: a Material's payload. Kept as a
// constant (canonical LC `Material.content`), deliberately NOT a wording alias,
// so `upsert_property` cannot reach load-bearing content — only add_node
// (via properties.content) and set_content write it.
export const MATERIAL_CONTENT_PATH = "raw.content";

// Every verb carries the namespace it operates in; the rest is verb-specific.
export type RecipeCommon = { namespace: string };
