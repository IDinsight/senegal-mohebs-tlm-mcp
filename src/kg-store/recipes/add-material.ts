// ── Recipe: add_material (Scope C) ───────────────────────────────────────────
// Create a content `Material` node — the actual reviewable, load-bearing prose /
// steps / numbers / image-brief — and link it to an EXISTING container via
// `hasPart`, one atomic composite. Additive.
//
// A Material can hang off THREE container levels (all via `hasPart`): an
// `Activity` (an Étape's script), a `Lesson` (session-level material, e.g. the
// shared reading text or the metadata block), or a `LessonGrouping` (a week/
// chapter, e.g. an opening-scene image for the whole week). The parent's kind is
// validated against those three.
//
// The payload lives on `Material.content` (raw.content — see MATERIAL_CONTENT_PATH):
// content is NOT a wording alias, so `upsert_property` can't touch it — only this
// recipe and `set_material_content` write it. `materialType` (Core / Supporting /
// Reference) and an optional title are the other fields.

import type { GraphMutation } from "../mutations.js";
import type { MutationGraph, MutationNode } from "../types.js";
import { createNode, linkNodes } from "../structural.js";
import {
  type RecipeCommon,
  K_LESSON_POSITION, W_TEXT, W_TEXT_EN, MATERIAL_CONTENT_PATH,
  nodeById, readLogical, asNum, buildProps,
  stampLcProps, lcLabels,
} from "./shared.js";

export type AddMaterialArgs = RecipeCommon & {
  parentId: string;             // the EXISTING container (Activity / Lesson / LessonGrouping) this material hangs off
  materialId: string;           // minted by the tool layer
  content: string;              // the payload (HTML/prose/steps/image-brief) → raw.content
  materialType?: string;        // Core (default) / Supporting / Reference
  text?: string;                // optional title
  text_en?: string;
  position?: number;            // within-parent order; defaults to appending
};

// The kinds a Material may hang off, drawn from the profile — Activity, Lesson,
// or the top container (a week/chapter LessonGrouping). Deduped so a profile
// whose kinds coincide still yields a clean set.
const parentKinds = (a: AddMaterialArgs): string[] =>
  [a.profile.activityKind, a.profile.lessonKind, a.profile.chapterKind].filter((k): k is string => !!k);

// The Material children a container already holds, via the container (hasPart) EDGE.
function childMaterials(g: MutationGraph, parentId: string, materialKind: string, containerEdge: string): MutationNode[] {
  const out: MutationNode[] = [];
  for (const e of g.edges) {
    if (e.type !== containerEdge || e.from !== parentId) continue;
    const child = nodeById(g, e.to);
    if (child && child.type === materialKind) out.push(child);
  }
  return out;
}

export const addMaterial: GraphMutation<AddMaterialArgs> = {
  name: "addMaterial",
  describe: (a) => `add a material to '${a.parentId}'`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    if (!a.profile.materialKind) errors.push(`add_material: this subject declares no materialKind in its recipeProfile.`);
    const parent = nodeById(base, a.parentId);
    const kinds = parentKinds(a);
    if (!parent) errors.push(`add_material: parent '${a.parentId}' does not exist in the draft.`);
    else if (!kinds.includes(parent.type)) errors.push(`add_material: node '${a.parentId}' is a '${parent.type}'; a material must hang off one of: ${kinds.join(", ")}.`);
    if (typeof a.content !== "string" || a.content.length === 0) errors.push(`add_material: 'content' (the material payload) is required.`);
    if (base.nodes.some((n) => n.id === a.materialId)) errors.push(`add_material: minted material id '${a.materialId}' already exists (retry).`);
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    const materialKind = a.profile.materialKind;
    const parent = nodeById(base, a.parentId);
    if (!parent || !materialKind || !parentKinds(a).includes(parent.type)) return base;
    const siblings = childMaterials(base, a.parentId, materialKind, a.profile.containerEdge);
    const position = a.position ?? (siblings.reduce((m, s) => Math.max(m, asNum(readLogical(s, materialKind, K_LESSON_POSITION, a.structuralAliases)) ?? 0), 0) + 1);
    let properties = buildProps(
      [
        { aliases: a.wordingAliases, kind: materialKind, key: W_TEXT, value: a.text },
        { aliases: a.wordingAliases, kind: materialKind, key: W_TEXT_EN, value: a.text_en },
        { aliases: a.structuralAliases, kind: materialKind, key: K_LESSON_POSITION, value: position },
      ],
      [
        { path: MATERIAL_CONTENT_PATH, value: a.content },
        { path: "raw.materialType", value: a.materialType ?? "Core" },
      ],
    );
    properties = stampLcProps(properties, materialKind, a.lcNodeTemplate, null);
    let g = createNode.apply(base, { kind: materialKind, properties, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.materialId, labels: lcLabels(materialKind, a.lcNodeTemplate) });
    g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.parentId, toId: a.materialId, properties: { orderInParent: position }, namespace: a.namespace });
    return g;
  },
};
