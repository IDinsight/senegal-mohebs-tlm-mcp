// ── Recipe: set_material_content (Scope C) ───────────────────────────────────
// Rewrite an EXISTING `Material` node's payload — its `content` (raw.content, see
// MATERIAL_CONTENT_PATH). The one editorial verb for load-bearing content: it is
// deliberately separate from `upsert_property` (which is wording-only and cannot
// reach content) so editing the reviewable payload is an explicit, audited act.
// Immutable set of a single path; every other property is preserved verbatim.

import type { GraphMutation } from "../mutations.js";
import { writeAtPath } from "../upsert-property.js";
import { type RecipeCommon, MATERIAL_CONTENT_PATH, nodeById } from "./shared.js";

export type SetMaterialContentArgs = RecipeCommon & {
  materialId: string;   // the EXISTING material whose content to replace
  content: string;      // the new payload → raw.content
};

export const setMaterialContent: GraphMutation<SetMaterialContentArgs> = {
  name: "setMaterialContent",
  describe: (a) => `set the content of material '${a.materialId}'`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    if (!a.profile.materialKind) errors.push(`set_material_content: this subject declares no materialKind in its recipeProfile.`);
    const material = nodeById(base, a.materialId);
    if (!material) errors.push(`set_material_content: material '${a.materialId}' does not exist in the draft.`);
    else if (material.type !== a.profile.materialKind) errors.push(`set_material_content: node '${a.materialId}' is a '${material.type}', not a ${a.profile.materialKind}.`);
    if (typeof a.content !== "string" || a.content.length === 0) errors.push(`set_material_content: 'content' is required (to remove a material, delete the node instead).`);
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    const material = nodeById(base, a.materialId);
    if (!material || material.type !== a.profile.materialKind) return base;
    return {
      nodes: base.nodes.map((n) =>
        n.id === a.materialId ? { ...n, properties: writeAtPath(n.properties, MATERIAL_CONTENT_PATH, a.content) } : n,
      ),
      edges: base.edges,
    };
  },
};
