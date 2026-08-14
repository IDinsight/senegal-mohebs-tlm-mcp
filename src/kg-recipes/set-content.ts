/*
 * Recipe: set_content (generic)
 *
 * Replace a node's load-bearing `content` (canonical LC `Material.content`, see
 * MATERIAL_CONTENT_PATH). The one verb for content, so editing the reviewable
 * payload is an explicit, audited act. Immutable single-path set; everything else
 * is preserved.
 */

import { writeAtPath, type GraphMutation } from "../kg-store/index.js";
import { RecipeCommon, MATERIAL_CONTENT_PATH, nodeById } from "./shared.js";

export type SetContentArgs = RecipeCommon & {
  nodeId: string;
  content: string;
};

export const setContent: GraphMutation<SetContentArgs> = {
  name: "setContent",
  describe: (args) => `set the content of '${args.nodeId}'`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (!nodeById(base, args.nodeId)) errors.push(`set_content: node '${args.nodeId}' does not exist in the draft.`);
    if (typeof args.content !== "string" || args.content.length === 0) errors.push(`set_content: 'content' is required (to remove content, delete the node instead).`);
    return { errors, warnings: [] };
  },
  apply: (base, args) => {
    const node = nodeById(base, args.nodeId);
    if (!node) return base;

    const nodesWithContent = base.nodes.map((candidate) => {
      if (candidate.id !== args.nodeId) return candidate;
      const properties = writeAtPath(candidate.properties, MATERIAL_CONTENT_PATH, args.content);
      return { ...candidate, properties };
    });
    return { nodes: nodesWithContent, edges: base.edges };
  },
};
