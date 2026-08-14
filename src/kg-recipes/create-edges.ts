/*
 * Recipe: create_edges (batched)
 *
 * Add MANY edges in one atomic draft edit — the batch form of create_edge, so
 * wiring (e.g. 84 hasEducationalAlignment edges after a bulk add_nodes) is one
 * dry-run + one confirm. Every edge runs the same single-edge `linkNodes`,
 * folded over an accumulating graph, so the batch is ONE mutation → one diff →
 * one confirmation token → one apply audit record.
 *
 * Duplicate detection spans BOTH the batch and the current draft: linkNodes
 * rejects a repeated (type, from, to) triple, and threading the accumulating
 * graph makes each edge visible to the next item's check. Endpoints must already
 * exist — ids minted by a prior committed add_nodes are valid here.
 * Rationale: docs/design-notes/graph-native-authoring.md.
 */

import { linkNodes, type GraphMutation, type LinkNodesArgs } from "../kg-store/index.js";
import { RecipeCommon } from "./shared.js";

// One edge to create — the same fields create_edge takes, minus the namespace
// (shared across the batch).
export type CreateEdgesItem = {
  edgeType: string;
  fromId: string;
  toId: string;
  properties?: Record<string, unknown>;
};

export type CreateEdgesArgs = RecipeCommon & { edges: CreateEdgesItem[] };

// Every item's link args carry the shared namespace and a concrete properties
// bag (linkNodes writes {} rather than an absent field).
function toLinkArgs(edge: CreateEdgesItem, namespace: string): LinkNodesArgs {
  return {
    edgeType: edge.edgeType,
    fromId: edge.fromId,
    toId: edge.toId,
    properties: edge.properties ?? {},
    namespace,
  };
}

export const createEdges: GraphMutation<CreateEdgesArgs> = {
  name: "createEdges",
  describe: (args) => `create ${args.edges.length} edge(s) in one batch`,

  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (!Array.isArray(args.edges) || args.edges.length === 0) {
      errors.push("create_edges: 'edges' must be a non-empty array.");
      return { errors, warnings: [] };
    }

    // Thread the accumulating graph so a duplicate edge that appears TWICE in
    // the batch is caught: linkNodes blocks the repeat once the first copy has
    // been applied into `graph`. The draft's own edges are already in `base`,
    // so a triple that collides with the draft is caught too.
    let graph = base;
    args.edges.forEach((edge, index) => {
      const linkArgs = toLinkArgs(edge, args.namespace);
      const singleEdgeResult = linkNodes.validate!(graph, graph, linkArgs);
      for (const message of singleEdgeResult.errors) {
        errors.push(`create_edges[${index}]: ${message}`);
      }
      graph = linkNodes.apply(graph, linkArgs);
    });

    return { errors, warnings: [] };
  },

  apply: (base, args) => {
    let graph = base;
    for (const edge of args.edges) {
      graph = linkNodes.apply(graph, toLinkArgs(edge, args.namespace));
    }
    return graph;
  },
};
