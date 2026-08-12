// Public surface of the kg-recipes module — the generic, subject-agnostic
// curriculum verbs (add_node / move_node / reposition / set_content) that
// COMPOSE the kg-store structural primitives, plus the registry get_capabilities
// mirrors. Recipes speak pure canonical LC (see lc.ts) and derive a created
// node's identity from the graph itself — there is no RecipeProfile.
//
// Layering: this is a services-layer module that imports kg-store ONLY through
// its barrel (../kg-store/index.js); kg-store never imports back, so the edge is
// one-way (no cycle). External callers (server/*) import the verbs from here.

export { addNode, type AddNodeArgs } from "./add-node.js";
export { moveNode, type MoveNodeArgs } from "./move-node.js";
export { reposition, type RepositionArgs } from "./reposition.js";
export { setContent, type SetContentArgs } from "./set-content.js";
export { RECIPES, type RecipeDescriptor, type RecipeParam } from "./registry.js";
export {
  containmentEdgeFor, deriveTemplate, isKnownLabel, orderPathsOf,
  ALIGNMENT_EDGE, POSITION, type NodeTemplate,
} from "./lc.js";
