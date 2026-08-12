/*
 * Recipe: add_node (generic)
 *
 * Create ONE node with an LC `label` and attach it under `parentId` via the
 * canonical containment edge (hasPart for content, hasChild for standards —
 * override with `via`), at a `position`, optionally aligned to a standard
 * (`alignTo` → hasEducationalAlignment). One atomic composite. The new node's
 * identity is copied from an existing node of the same label (deriveTemplate);
 * extra props ride the freeform `properties` bag (→ raw.*).
 *
 * Rationale: docs/design-notes/graph-native-authoring.md.
 */

import { createNode, linkNodes, type GraphMutation, type MutationNode } from "../kg-store/index.js";
import { RecipeCommon, buildCreatedProps, nextPosition, nodeById } from "./shared.js";
import { ALIGNMENT_EDGE, containmentEdgeFor, deriveTemplate, isKnownLabel } from "./lc.js";

export type AddNodeArgs = RecipeCommon & {
  parentId: string;                       // the container to attach under
  label: string;                          // LC label of the new node (Activity / Material / Lesson / LessonGrouping / …)
  newNodeId: string;                      // minted by the tool layer
  title?: string;
  title_en?: string;
  position?: number;                      // within-parent order; defaults to appending
  via?: string;                           // containment-edge override; defaults to the canonical edge for `label`
  alignTo?: string;                       // an SFI id to align to (hasEducationalAlignment)
  properties?: Record<string, unknown>;   // extra canonical LC props → written under raw.* (content, materialType, studentGroupingType, educationalUse, groupName, …)
};

const isSfi = (n: MutationNode): boolean => (n.labels ?? []).includes("StandardsFrameworkItem");

export const addNode: GraphMutation<AddNodeArgs> = {
  name: "addNode",
  describe: (a) => `create a '${a.label}' under '${a.parentId}'${a.alignTo ? ` (aligned to '${a.alignTo}')` : ""}`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    if (typeof a.label !== "string" || a.label.length === 0) errors.push(`add_node: 'label' (the LC node label) is required.`);
    else if (!isKnownLabel(base, a.label)) errors.push(`add_node: '${a.label}' is not a known LC label on this namespace (and none exists to copy). Known content labels: Course, LessonGrouping, Lesson, Activity, Material.`);
    if (!nodeById(base, a.parentId)) errors.push(`add_node: parent '${a.parentId}' does not exist in the draft.`);
    if (base.nodes.some((n) => n.id === a.newNodeId)) errors.push(`add_node: minted id '${a.newNodeId}' already exists (retry).`);
    if (a.alignTo) {
      const target = nodeById(base, a.alignTo);
      if (!target) errors.push(`add_node: alignTo '${a.alignTo}' does not exist — a node can only align to a standard that already exists.`);
      else if (!isSfi(target)) errors.push(`add_node: alignTo '${a.alignTo}' is not a StandardsFrameworkItem; alignment targets a standard.`);
    }
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    // apply() runs before validate() on the dry-run, so a bad parent id must
    // return base (→ clean "blocked" from validate) rather than throw here.
    const parent = nodeById(base, a.parentId);
    if (!parent) return base;
    const template = deriveTemplate(base, a.label);
    const edge = a.via ?? containmentEdgeFor(a.label);
    const position = a.position ?? nextPosition(base, a.parentId, edge);
    const isAssessment = a.properties?.educationalUse === "Assessment";
    const props = buildCreatedProps(template, { title: a.title, title_en: a.title_en, position, isAssessment, extraRaw: a.properties });
    let g = createNode.apply(base, { kind: template.kind, properties: props, namespace: a.namespace, aliases: {}, newNodeId: a.newNodeId, labels: template.labels });
    g = linkNodes.apply(g, { edgeType: edge, fromId: a.parentId, toId: a.newNodeId, properties: { orderInParent: position }, namespace: a.namespace });
    if (a.alignTo && nodeById(base, a.alignTo)) {
      g = linkNodes.apply(g, { edgeType: ALIGNMENT_EDGE, fromId: a.newNodeId, toId: a.alignTo, properties: {}, namespace: a.namespace });
    }
    return g;
  },
};
