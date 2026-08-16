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

const labelOf = (node: { labels?: string[] } | undefined): string => node?.labels?.[0] ?? "";

export const moveNode: GraphMutation<MoveNodeArgs> = {
  name: "moveNode",
  describe: (args) => `move '${args.nodeId}' under '${args.toParentId}'`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    const node = nodeById(base, args.nodeId);
    const parent = nodeById(base, args.toParentId);

    if (!node) errors.push(`move_node: node '${args.nodeId}' does not exist in the draft.`);
    if (!parent) errors.push(`move_node: target parent '${args.toParentId}' does not exist in the draft.`);
    if (args.nodeId === args.toParentId) errors.push(`move_node: a node cannot be its own parent.`);

    if (node) {
      const nodeLabel = labelOf(node);
      const edgeType = args.via ?? containmentEdgeFor(nodeLabel);
      if (parentEdgeIds(base, args.nodeId, edgeType).length === 0) {
        errors.push(`move_node: '${args.nodeId}' has no '${edgeType}' parent to move from (pass 'via' to name the axis).`);
      }
    }
    return { errors, warnings: [] };
  },
  apply: (base, args) => {
    const node = nodeById(base, args.nodeId);
    const parent = nodeById(base, args.toParentId);
    if (!node || !parent) return base;

    const nodeLabel = labelOf(node);
    const edgeType = args.via ?? containmentEdgeFor(nodeLabel);

    // Detach the node from every current parent on this axis before re-attaching.
    let graph = base;
    for (const edgeId of parentEdgeIds(graph, args.nodeId, edgeType)) {
      graph = unlinkNodes.apply(graph, { edgeId });
    }

    // Attach it under the new parent, appending unless a position was given.
    const position = args.position ?? nextPosition(graph, args.toParentId, edgeType);
    graph = linkNodes.apply(graph, {
      edgeType,
      fromId: args.toParentId,
      toId: args.nodeId,
      properties: { orderInParent: position },
      namespace: args.namespace,
    });

    // Keep the node's own POSITION field consistent with its new slot.
    const repositionedNodes = setPosition(graph.nodes, args.nodeId, position);
    graph = { nodes: repositionedNodes, edges: graph.edges };
    return graph;
  },
};
