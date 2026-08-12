/*
 * Recipe: move_node (generic)
 *
 * Re-parent a node along ONE containment axis: detach its current parent edge(s)
 * on that axis, attach the new parent, set its position. One atomic composite.
 * The axis is the node's canonical containment edge (hasPart for content),
 * overridable via `via`. Only that axis moves — e.g. a maths lesson lives under
 * both a chapter (hasPart) and a week (hasChild); moving it to another chapter
 * leaves the week untouched.
 */

import { linkNodes, unlinkNodes, type GraphMutation } from "../kg-store/index.js";
import { RecipeCommon, nextPosition, nodeById, parentEdgeIds, setPosition } from "./shared.js";
import { containmentEdgeFor } from "./lc.js";

export type MoveNodeArgs = RecipeCommon & {
  nodeId: string;
  toParentId: string;
  via?: string;          // containment-edge axis; defaults to the node's canonical edge
  position?: number;     // within-target order; defaults to appending
};

const labelOf = (n: { labels?: string[] } | undefined): string => n?.labels?.[0] ?? "";

export const moveNode: GraphMutation<MoveNodeArgs> = {
  name: "moveNode",
  describe: (a) => `move '${a.nodeId}' under '${a.toParentId}'`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const node = nodeById(base, a.nodeId);
    const parent = nodeById(base, a.toParentId);
    if (!node) errors.push(`move_node: node '${a.nodeId}' does not exist in the draft.`);
    if (!parent) errors.push(`move_node: target parent '${a.toParentId}' does not exist in the draft.`);
    if (a.nodeId === a.toParentId) errors.push(`move_node: a node cannot be its own parent.`);
    if (node) {
      const edge = a.via ?? containmentEdgeFor(labelOf(node));
      if (parentEdgeIds(base, a.nodeId, edge).length === 0)
        errors.push(`move_node: '${a.nodeId}' has no '${edge}' parent to move from (pass 'via' to name the axis).`);
    }
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    const node = nodeById(base, a.nodeId);
    const parent = nodeById(base, a.toParentId);
    if (!node || !parent) return base;
    const edge = a.via ?? containmentEdgeFor(labelOf(node));
    // Detach every current parent on this axis, then attach the new one.
    let g = base;
    for (const edgeId of parentEdgeIds(g, a.nodeId, edge)) g = unlinkNodes.apply(g, { edgeId });
    const position = a.position ?? nextPosition(g, a.toParentId, edge);
    g = linkNodes.apply(g, { edgeType: edge, fromId: a.toParentId, toId: a.nodeId, properties: { orderInParent: position }, namespace: a.namespace });
    // Keep the node's own POSITION consistent with its new slot.
    g = { nodes: setPosition(g.nodes, a.nodeId, position), edges: g.edges };
    return g;
  },
};
