/*
 * Recipe: reposition (generic)
 *
 * Set ONE node's POSITION — its ordinal among its siblings. Membership is the
 * containment EDGE, not a number, so bumping a node's position never touches its
 * children or siblings: it is a single-node edit.
 */

import { type GraphMutation } from "../kg-store/index.js";
import { RecipeCommon, nodeById, setPosition } from "./shared.js";

export type RepositionArgs = RecipeCommon & {
  nodeId: string;
  position: number;
};

export const reposition: GraphMutation<RepositionArgs> = {
  name: "reposition",
  describe: (args) => `set the position of '${args.nodeId}' to ${args.position}`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (!nodeById(base, args.nodeId)) errors.push(`reposition: node '${args.nodeId}' does not exist in the draft.`);
    if (typeof args.position !== "number" || !Number.isFinite(args.position)) errors.push(`reposition: 'position' must be a number.`);
    return { errors, warnings: [] };
  },
  apply: (base, args) => {
    if (!nodeById(base, args.nodeId)) return base;
    const repositionedNodes = setPosition(base.nodes, args.nodeId, args.position);
    return { nodes: repositionedNodes, edges: base.edges };
  },
};
