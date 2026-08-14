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

export const asNum = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export const nodeById = (graph: MutationGraph, id: string): MutationNode | undefined => graph.nodes.find((node) => node.id === id);

// The children of `parentId` reachable via `edgeType` — the id-based containment
// backbone, subject-agnostic (works for hasPart, hasChild, supports alike).
export function childrenVia(graph: MutationGraph, parentId: string, edgeType: string): MutationNode[] {
  const children: MutationNode[] = [];
  for (const edge of graph.edges) {
    if (edge.type !== edgeType || edge.from !== parentId) continue;
    const child = nodeById(graph, edge.to);
    if (child) children.push(child);
  }
  return children;
}

// The containment edges pointing AT a node (its parents on `edgeType`). Normally
// one; more than one is a legitimate multi-axis state (a maths lesson under both a
// grouping and a week). move_node detaches all of a given edge before relinking.
export function parentEdgeIds(graph: MutationGraph, childId: string, edgeType: string): string[] {
  const parentEdges = graph.edges.filter((edge) => edge.type === edgeType && edge.to === childId);
  return parentEdges.map((edge) => edge.id);
}

// A node's POSITION — the single ordinal concept (the normalized top-level
// `order`, mirrored into raw at a source-specific path the template knows).
export const positionOf = (node: MutationNode): number => {
  const rawOrder = readAtPath(node.properties, POSITION);
  return asNum(rawOrder) ?? 0;
};

// The next free position when appending under `parentId` on `edgeType`: max
// sibling position + 1 (1 when empty). Subject-agnostic — every kind orders alike.
export function nextPosition(graph: MutationGraph, parentId: string, edgeType: string): number {
  let highestPosition = 0;
  for (const child of childrenVia(graph, parentId, edgeType)) {
    highestPosition = Math.max(highestPosition, positionOf(child));
  }
  return highestPosition + 1;
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
  template: NodeTemplate,
  opts: { id?: string; title?: string; title_en?: string; position: number; isAssessment: boolean; extraRaw?: Record<string, unknown> },
): Record<string, unknown> {
  let props: Record<string, unknown> = { raw: {} };

  // Normalized (top-level) fields the store keeps alongside raw.
  props = put(props, template.isGrouping ? "title" : "text", opts.title);
  props = put(props, POSITION, opts.position);
  if (opts.isAssessment) {
    props = put(props, "isAssessment", true);
  }

  // Raw passthrough — what the parser reads on re-hydration. Boilerplate first
  // (license/provider/… copied from a sibling), so any author-supplied extraRaw
  // key can still override it.
  for (const [key, value] of Object.entries(template.boilerplate)) {
    props = put(props, `raw.${key}`, value);
  }
  props = put(props, "raw.identifier", opts.id);
  props = put(props, "raw.description", opts.title);
  props = put(props, "raw.metadata.en.description", opts.title_en);
  for (const orderPath of template.orderPaths) {
    props = put(props, orderPath, opts.position);
  }
  props = put(props, "raw.normalizedType", template.normalizedType);
  props = put(props, "raw.normalizedStatementType", template.normalizedStatementType);
  props = put(props, "raw.metadata.role", template.role);
  for (const [key, value] of Object.entries(opts.extraRaw ?? {})) {
    props = put(props, `raw.${key}`, value);
  }
  return props;
}

// Set a node's POSITION — the single ordinal — writing BOTH the normalized
// top-level `order` and the node's own raw mirror path (so it round-trips at the
// source's convention). Immutable; used by move_node and reposition.
export function setPosition(nodes: MutationNode[], nodeId: string, position: number): MutationNode[] {
  return nodes.map((node) => {
    if (node.id !== nodeId) return node;
    let props = writeAtPath(node.properties, POSITION, position);
    const orderPaths = orderPathsOf(node);
    const pathsToWrite = orderPaths.length ? orderPaths : ["raw.position"];
    for (const path of pathsToWrite) {
      props = writeAtPath(props, path, position);
    }
    return { ...node, properties: props };
  });
}

// The one non-canonical-but-LC content path: a Material's payload. Kept as a
// constant (canonical LC `Material.content`), deliberately NOT a wording alias,
// so `upsert_property` cannot reach load-bearing content — only add_node
// (via properties.content) and set_content write it.
export const MATERIAL_CONTENT_PATH = "raw.content";

// Every verb carries the namespace it operates in; the rest is verb-specific.
export type RecipeCommon = { namespace: string };
