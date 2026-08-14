/*
 * Recipe: add_nodes (batched)
 *
 * Create MANY nodes in one atomic draft edit — the batch form of add_node, so a
 * bulk pass (e.g. 88 StandardsFrameworkItems under a framework) is one dry-run +
 * one confirm instead of ~180 round-trips. Every item runs the exact same
 * single-item `addNode.apply`, folded over an accumulating graph, so the whole
 * batch is ONE mutation → one diff → one confirmation token → one apply audit
 * record (the shape use_routine already uses for cloned subtrees).
 *
 * SCOPE: each item attaches under an EXISTING parent. Referencing a node minted
 * earlier in the same batch as a parent is deliberately unsupported — stage the
 * nodes here, then wire cross-references with create_edges (or a follow-up
 * composite recipe). Rationale: docs/design-notes/graph-native-authoring.md.
 */

import type { GraphMutation } from "../kg-store/index.js";
import { addNode, type AddNodeArgs } from "./add-node.js";
import { RecipeCommon, nodeById } from "./shared.js";
import { isKnownLabel } from "./lc.js";

// One node to create — the same fields add_node takes, minus the namespace
// (shared across the batch). `newNodeId` is minted per item by the tool layer.
export type AddNodesItem = {
  label: string;                          // LC label of the new node (the tool's `kind`)
  parentId?: string;                      // an EXISTING container; omit for a root (Course/StandardsFramework)
  newNodeId: string;                      // minted by the tool layer, one per item
  title?: string;                         // display text → normalized title/text + raw.description
  title_en?: string;
  position?: number;                      // within-parent order; defaults to appending
  via?: string;                           // containment-edge override; defaults to the canonical edge for `label`
  alignTo?: string;                       // an existing SFI to align to (hasEducationalAlignment)
  properties?: Record<string, unknown>;   // kind-specific canonical LC props → raw.* (audience, groupName, statementType, content, …)
};

export type AddNodesArgs = RecipeCommon & { items: AddNodesItem[] };

const isSfi = (labels: string[] | undefined): boolean => (labels ?? []).includes("StandardsFrameworkItem");

// Map one batch item onto the single-item recipe's args, threading the shared
// namespace. Identical field-for-field to what runTypedAdd builds per node.
function toAddNodeArgs(item: AddNodesItem, namespace: string): AddNodeArgs {
  return {
    namespace,
    parentId: item.parentId,
    label: item.label,
    newNodeId: item.newNodeId,
    title: item.title,
    title_en: item.title_en,
    position: item.position,
    via: item.via,
    alignTo: item.alignTo,
    properties: item.properties,
  };
}

export const addNodes: GraphMutation<AddNodesArgs> = {
  name: "addNodes",
  describe: (args) => `create ${args.items.length} node(s) in one batch`,

  // Validate every item and collect ALL failures — the framework blocks the
  // whole batch on any error (no token, no partial apply), so the caller fixes
  // them in one pass rather than discovering them one round-trip at a time.
  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (!Array.isArray(args.items) || args.items.length === 0) {
      errors.push("add_nodes: 'items' must be a non-empty array.");
      return { errors, warnings: [] };
    }

    // Track ids minted so far in THIS batch so two items minting the same id
    // (or an item colliding with an existing node) are both caught.
    const mintedSoFar = new Set<string>();

    args.items.forEach((item, index) => {
      const where = `add_nodes[${index}]`;

      if (typeof item.label !== "string" || item.label.length === 0) {
        errors.push(`${where}: 'label' (the LC node label) is required.`);
      } else if (!isKnownLabel(base, item.label)) {
        errors.push(`${where}: '${item.label}' is not a known LC label on this namespace (and none exists to copy). Known content labels: Course, LessonGrouping, Lesson, Activity, Material.`);
      }

      // Existing-parents-only: the parent must already be in the draft. A node
      // minted earlier in the same batch is NOT a valid parent here.
      if (item.parentId && !nodeById(base, item.parentId)) {
        errors.push(`${where}: parent '${item.parentId}' does not exist in the draft. add_nodes needs an EXISTING parent — a node minted in the same batch cannot be a parent (stage nodes, then wire them with create_edges).`);
      }

      if (typeof item.newNodeId !== "string" || item.newNodeId.length === 0) {
        errors.push(`${where}: newNodeId is missing (tool-layer bug — the server mints one per item).`);
      } else if (nodeById(base, item.newNodeId) || mintedSoFar.has(item.newNodeId)) {
        errors.push(`${where}: minted id '${item.newNodeId}' already exists or repeats within this batch (retry).`);
      }
      if (item.newNodeId) {
        mintedSoFar.add(item.newNodeId);
      }

      if (item.alignTo) {
        const target = nodeById(base, item.alignTo);
        if (!target) {
          errors.push(`${where}: alignTo '${item.alignTo}' does not exist — a node can only align to a standard that already exists.`);
        } else if (!isSfi(target.labels)) {
          errors.push(`${where}: alignTo '${item.alignTo}' is not a StandardsFrameworkItem; alignment targets a standard.`);
        }
      }
    });

    return { errors, warnings: [] };
  },

  // Fold each item through the SAME single-item apply, over an accumulating
  // graph. Two items under the same parent therefore get sequential positions
  // (item 2 sees item 1's node when it computes nextPosition), and a batch that
  // creates the first-ever node of a label lets later items of that label copy
  // its shape. A bad-parent item leaves the graph unchanged for that item (its
  // own apply guards it), and validate then blocks the whole batch.
  apply: (base, args) => {
    let graph = base;
    for (const item of args.items) {
      graph = addNode.apply(graph, toAddNodeArgs(item, args.namespace));
    }
    return graph;
  },
};
