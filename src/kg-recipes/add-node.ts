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
  parentId?: string;                      // the container to attach under; omitted for a ROOT node (Course/StandardsFramework)
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
  describe: (args) => `create a '${args.label}' under '${args.parentId}'${args.alignTo ? ` (aligned to '${args.alignTo}')` : ""}`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (typeof args.label !== "string" || args.label.length === 0) errors.push(`add_node: 'label' (the LC node label) is required.`);
    else if (!isKnownLabel(base, args.label)) errors.push(`add_node: '${args.label}' is not a known LC label on this namespace (and none exists to copy). Known content labels: Course, LessonGrouping, Lesson, Activity, Material.`);
    if (args.parentId && !nodeById(base, args.parentId)) errors.push(`add_node: parent '${args.parentId}' does not exist in the draft.`);
    if (base.nodes.some((node) => node.id === args.newNodeId)) errors.push(`add_node: minted id '${args.newNodeId}' already exists (retry).`);
    if (args.alignTo) {
      const target = nodeById(base, args.alignTo);
      if (!target) errors.push(`add_node: alignTo '${args.alignTo}' does not exist — a node can only align to a standard that already exists.`);
      else if (!isSfi(target)) errors.push(`add_node: alignTo '${args.alignTo}' is not a StandardsFrameworkItem; alignment targets a standard.`);
    }
    return { errors, warnings: [] };
  },
  apply: (base, args) => {
    // apply() runs before validate() on the dry-run, so a bad parent id must
    // return base (→ clean "blocked" from validate) rather than throw here.
    if (args.parentId && !nodeById(base, args.parentId)) return base;

    const template = deriveTemplate(base, args.label);
    const edgeType = args.via ?? containmentEdgeFor(args.label);
    const position = args.position ?? (args.parentId ? nextPosition(base, args.parentId, edgeType) : 1);
    const isAssessment = args.properties?.educationalUse === "Assessment";

    const properties = buildCreatedProps(template, {
      id: args.newNodeId,
      title: args.title,
      title_en: args.title_en,
      position,
      isAssessment,
      extraRaw: args.properties,
    });
    let graph = createNode.apply(base, {
      kind: template.kind,
      properties,
      namespace: args.namespace,
      aliases: {},
      newNodeId: args.newNodeId,
      labels: template.labels,
    });

    // Root node (no parentId, e.g. Course) — no containment edge. Otherwise:
    // containment (hasPart/hasChild) points parent→child; `supports`
    // (LearningComponent→SFI) points child→parent, so the new node is the source.
    if (args.parentId) {
      if (edgeType === "supports") {
        graph = linkNodes.apply(graph, {
          edgeType,
          fromId: args.newNodeId,
          toId: args.parentId,
          properties: {},
          namespace: args.namespace,
        });
      } else {
        graph = linkNodes.apply(graph, {
          edgeType,
          fromId: args.parentId,
          toId: args.newNodeId,
          properties: { orderInParent: position },
          namespace: args.namespace,
        });
      }
    }

    if (args.alignTo && nodeById(base, args.alignTo)) {
      graph = linkNodes.apply(graph, {
        edgeType: ALIGNMENT_EDGE,
        fromId: args.newNodeId,
        toId: args.alignTo,
        properties: {},
        namespace: args.namespace,
      });
    }
    return graph;
  },
};
