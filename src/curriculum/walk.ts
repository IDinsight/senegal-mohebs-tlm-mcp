/*
 * Module: curriculum · generic graph walk
 *
 * The reader behind the walk_graph tool: one BFS from a start node over the
 * echoed raw Learning-Commons graph (`model.rawGraph`), filtered by edge type,
 * node label, and direction, paged with an opaque cursor. It is the single
 * generic traversal primitive — the same call discovers a framework root
 * (walk "in" over hasChild) or a whole course subtree (walk "out" over
 * hasPart/hasChild). No subject vocabulary, no projection: it surfaces raw
 * nodes + the edges it traversed so the caller can rebuild the subgraph.
 *
 * Pagination is stateless, like read_audit: each call re-runs the SAME
 * deterministic BFS and slices it, so a cursor is just a boundary key — no
 * frontier state is carried across calls. Full rationale + the get_course
 * removal it replaces: docs/design-notes/graph-native-authoring.md.
 */
import type { CurriculumModel, RawGraphSnapshot } from "../types.js";

type RawNode = RawGraphSnapshot["nodes"][number];
type RawEdge = RawGraphSnapshot["relationships"][number];

// A bare node/edge as returned to the caller — raw LC labels + properties, the
// same shape list_courses / get_standards surface.
type NodeOut = { id: string; labels: string[]; properties: Record<string, unknown> };
type EdgeOut = { id: string; type: string; start: string; end: string; properties: Record<string, unknown> };

const nodeOut = (node: RawNode): NodeOut => ({ id: node.id, labels: node.labels ?? [], properties: node.properties ?? {} });
const edgeOut = (edge: RawEdge): EdgeOut => ({ id: edge.id, type: edge.type, start: edge.start, end: edge.end, properties: edge.properties ?? {} });

// Direction of travel from a node: "out" follows edges start→end (a course to
// its parts), "in" follows end→start (a standard up to its framework root),
// "both" follows either.
export type WalkDirection = "out" | "in" | "both";

export type WalkArgs = {
  fromId: string;
  direction: WalkDirection;
  edgeTypes?: string[];   // follow only these edge types; empty/absent ⇒ all types
  nodeTypes?: string[];   // emit only nodes carrying one of these LC labels; empty/absent ⇒ all
  maxDepth?: number;      // hops from fromId; default 3, clamped to [1, MAX_DEPTH_CAP]
  includeEdges?: boolean; // default true — return traversed edges so callers can rebuild the subgraph
  limit?: number;         // page size; default 100, clamped to [1, MAX_LIMIT]
  cursor?: string;        // opaque, from a prior response's nextCursor
};

export type WalkResult = {
  nodes: NodeOut[];
  edges?: EdgeOut[];      // omitted entirely when includeEdges is false
  truncated: boolean;     // maxDepth cut the walk before exhaustion (nodes exist beyond the cap)
  nextCursor: string | null;
};

// A depth cap keeps a stray maxDepth from walking the whole graph; the default
// is deliberately shallow (a course → its lessons is 2–3 hops).
const DEFAULT_DEPTH = 3;
const MAX_DEPTH_CAP = 10;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

// ── Cursor: an opaque base64 of the last-emitted node's sort key ──────────────
// The BFS is re-run identically on every page, so resuming only needs to know
// where the previous page stopped in the canonical (depth, id) order. Same
// shape and validation as read_audit's cursor: a garbage cursor decodes to null
// so the caller gets a clear "invalid cursor" error rather than a wrong page.

type WalkCursor = { depth: number; id: string };

const encodeCursor = (boundary: WalkCursor): string =>
  Buffer.from(JSON.stringify(boundary), "utf8").toString("base64");

const decodeCursor = (cursor: string): WalkCursor | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.depth !== "number" || typeof candidate.id !== "string") return null;
    return { depth: candidate.depth, id: candidate.id };
  } catch {
    return null;
  }
};

// ── Adjacency ────────────────────────────────────────────────────────────────
// A visited node is reached at its SHORTEST hop count, so depth is well-defined
// regardless of edge iteration order — that determinism is what lets a stateless
// cursor resume the same walk. `neighboursOf` returns each edge we may follow
// out of a node under the direction + edgeType filters, tagged with the node it
// leads to, so the walk records the traversed edge alongside the reached node.

type Step = { edge: RawEdge; toNode: string };

function buildNeighbours(raw: RawGraphSnapshot, direction: WalkDirection, edgeTypeFilter: Set<string> | null): Map<string, Step[]> {
  const neighbours = new Map<string, Step[]>();

  const addStep = (fromNode: string, edge: RawEdge, toNode: string): void => {
    const steps = neighbours.get(fromNode) ?? [];
    steps.push({ edge, toNode });
    neighbours.set(fromNode, steps);
  };

  for (const edge of raw.relationships) {
    if (edgeTypeFilter && !edgeTypeFilter.has(edge.type)) {
      continue;
    }
    // "out" leaves a node by its outgoing edges (start→end); "in" by its
    // incoming edges (end→start); "both" by either. A node reached by an "in"
    // step is the edge's `start`.
    if (direction === "out" || direction === "both") {
      addStep(edge.start, edge, edge.end);
    }
    if (direction === "in" || direction === "both") {
      addStep(edge.end, edge, edge.start);
    }
  }
  return neighbours;
}

// The full BFS result before paging: every reached node's shortest depth, every
// edge actually traversed, and whether the depth cap hid deeper nodes.
type Traversal = {
  depthOf: Map<string, number>;
  traversedEdges: Map<string, RawEdge>;  // by edge id, so an edge reached twice appears once
  truncated: boolean;
};

function traverse(raw: RawGraphSnapshot, args: WalkArgs, maxDepth: number): Traversal {
  const edgeTypeFilter = args.edgeTypes && args.edgeTypes.length > 0 ? new Set(args.edgeTypes) : null;
  const neighbours = buildNeighbours(raw, args.direction, edgeTypeFilter);

  const depthOf = new Map<string, number>([[args.fromId, 0]]);
  const traversedEdges = new Map<string, RawEdge>();
  let truncated = false;

  // Level-by-level BFS: `frontier` holds the nodes at the current depth. A node
  // is only enqueued the first time it is seen, so its recorded depth is the
  // shortest — the property the cursor's ordering relies on.
  let frontier = [args.fromId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      for (const step of neighbours.get(nodeId) ?? []) {
        traversedEdges.set(step.edge.id, step.edge);
        if (!depthOf.has(step.toNode)) {
          depthOf.set(step.toNode, depth + 1);
          nextFrontier.push(step.toNode);
        }
      }
    }
    frontier = nextFrontier;
  }

  // The nodes still on the frontier sit at maxDepth. If any of them has an
  // onward neighbour we never reached, the cap — not exhaustion — ended the
  // walk, which is what `truncated` reports.
  for (const nodeId of frontier) {
    const hasUnreachedNeighbour = (neighbours.get(nodeId) ?? []).some((step) => !depthOf.has(step.toNode));
    if (hasUnreachedNeighbour) {
      truncated = true;
      break;
    }
  }

  return { depthOf, traversedEdges, truncated };
}

// ── The reader ────────────────────────────────────────────────────────────────
// Returns { error } for a caller-visible problem (unknown fromId, bad cursor) so
// the tool layer can surface a clear message, mirroring courseSubgraph's null.

export function walkGraph(model: CurriculumModel, args: WalkArgs): { error: string } | WalkResult {
  const raw = model.rawGraph;
  if (!raw) {
    return { error: "This subject's graph is not available as a raw envelope, so it cannot be walked." };
  }
  if (!raw.nodes.some((node) => node.id === args.fromId)) {
    return { error: `Start node '${args.fromId}' not found in the active graph.` };
  }

  const cursor = args.cursor ? decodeCursor(args.cursor) : null;
  if (args.cursor && !cursor) {
    return { error: "Invalid cursor — pass a cursor returned by a prior walk_graph page, unmodified." };
  }

  const maxDepth = clamp(args.maxDepth ?? DEFAULT_DEPTH, 1, MAX_DEPTH_CAP);
  const limit = clamp(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const nodeTypeFilter = args.nodeTypes && args.nodeTypes.length > 0 ? new Set(args.nodeTypes) : null;
  const includeEdges = args.includeEdges ?? true;

  const traversal = traverse(raw, args, maxDepth);
  const nodeById = new Map(raw.nodes.map((node) => [node.id, node]));

  // A node is emitted only if it matches the label filter — but the traversal
  // already walked THROUGH non-matching nodes, so filtering here never cuts the
  // walk short. fromId is filtered by the same rule as any other node.
  const matchesLabelFilter = (nodeId: string): boolean => {
    if (!nodeTypeFilter) {
      return true;
    }
    const node = nodeById.get(nodeId);
    return (node?.labels ?? []).some((label) => nodeTypeFilter.has(label));
  };

  // Canonical order for the whole result: depth first (fromId, then its
  // neighbours, …), ties broken by id. Paging slices this stable sequence, so
  // every page is a contiguous window and no node is served twice or skipped.
  const orderedIds = [...traversal.depthOf.keys()]
    .filter(matchesLabelFilter)
    .sort((left, right) => {
      const depthDifference = traversal.depthOf.get(left)! - traversal.depthOf.get(right)!;
      return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
    });

  // Resume just past the cursor's boundary in (depth, id) order.
  const startIndex = cursor
    ? orderedIds.findIndex((nodeId) => isAfterCursor(traversal.depthOf.get(nodeId)!, nodeId, cursor))
    : 0;
  const fromIndex = startIndex === -1 ? orderedIds.length : startIndex;
  const pageIds = orderedIds.slice(fromIndex, fromIndex + limit);
  const hasMore = fromIndex + limit < orderedIds.length;

  const nodes = pageIds.map((nodeId) => nodeOut(nodeById.get(nodeId)!));

  const result: WalkResult = {
    nodes,
    truncated: traversal.truncated,
    nextCursor: hasMore && pageIds.length > 0
      ? encodeCursor({ depth: traversal.depthOf.get(pageIds[pageIds.length - 1])!, id: pageIds[pageIds.length - 1] })
      : null,
  };

  if (includeEdges) {
    // Return the traversed edges touching this page's nodes, so the caller can
    // stitch the subgraph together. Across pages the union is the full traversed
    // edge set; within a page each edge id appears once.
    const pageNodeIds = new Set(pageIds);
    result.edges = [...traversal.traversedEdges.values()]
      .filter((edge) => pageNodeIds.has(edge.start) || pageNodeIds.has(edge.end))
      .map(edgeOut);
  }

  return result;
}

// Strictly-after test under the canonical (depth asc, id asc) order — the same
// ordering the page slice uses, so resume lands on the very next node.
function isAfterCursor(depth: number, id: string, cursor: WalkCursor): boolean {
  if (depth !== cursor.depth) {
    return depth > cursor.depth;
  }
  return id.localeCompare(cursor.id) > 0;
}
