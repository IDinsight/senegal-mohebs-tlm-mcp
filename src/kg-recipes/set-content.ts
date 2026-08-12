// ── Recipe: set_content (generic) ────────────────────────────────────────────
// Replace a node's load-bearing `content` (canonical LC `Material.content`, see
// MATERIAL_CONTENT_PATH). The one editorial verb for content: it is deliberately
// separate from `upsert_property` (wording-only — it cannot reach content), so
// editing the reviewable payload is an explicit, audited act. Immutable set of a
// single path; every other property is preserved verbatim. Replaces
// set_material_content, generalized to any node that carries content.

import { writeAtPath, type GraphMutation } from "../kg-store/index.js";
import { RecipeCommon, MATERIAL_CONTENT_PATH, nodeById } from "./shared.js";

export type SetContentArgs = RecipeCommon & {
  nodeId: string;
  content: string;
};

export const setContent: GraphMutation<SetContentArgs> = {
  name: "setContent",
  describe: (a) => `set the content of '${a.nodeId}'`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    if (!nodeById(base, a.nodeId)) errors.push(`set_content: node '${a.nodeId}' does not exist in the draft.`);
    if (typeof a.content !== "string" || a.content.length === 0) errors.push(`set_content: 'content' is required (to remove content, delete the node instead).`);
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    const node = nodeById(base, a.nodeId);
    if (!node) return base;
    return {
      nodes: base.nodes.map((n) => (n.id === a.nodeId ? { ...n, properties: writeAtPath(n.properties, MATERIAL_CONTENT_PATH, a.content) } : n)),
      edges: base.edges,
    };
  },
};
