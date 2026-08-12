// ── Recipe: reposition (generic) ─────────────────────────────────────────────
// Set ONE node's POSITION — its ordinal among its siblings. Replaces renumber.
// In canonical LC, membership is the containment EDGE, not a number, so changing
// a node's position never cascades to anything: it is a single-node ordinal edit.
// (The old renumber's chapter→lessons number cascade is gone with the join key.)

import { type GraphMutation } from "../kg-store/index.js";
import { RecipeCommon, nodeById, setPosition } from "./shared.js";

export type RepositionArgs = RecipeCommon & {
  nodeId: string;
  position: number;
};

export const reposition: GraphMutation<RepositionArgs> = {
  name: "reposition",
  describe: (a) => `set the position of '${a.nodeId}' to ${a.position}`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    if (!nodeById(base, a.nodeId)) errors.push(`reposition: node '${a.nodeId}' does not exist in the draft.`);
    if (typeof a.position !== "number" || !Number.isFinite(a.position)) errors.push(`reposition: 'position' must be a number.`);
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    if (!nodeById(base, a.nodeId)) return base;
    return { nodes: setPosition(base.nodes, a.nodeId, a.position), edges: base.edges };
  },
};
