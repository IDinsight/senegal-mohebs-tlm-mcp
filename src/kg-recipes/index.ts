/*
 * kg-recipes · public surface
 *
 * The generic curriculum verbs (add_node / move_node / reposition / set_content)
 * that compose kg-store's structural primitives, plus the get_capabilities
 * mirror. External callers (server/*) import the verbs from here.
 *
 * Layering gotcha: import kg-store ONLY through its barrel (../kg-store/index.js),
 * a one-way edge (kg-store never imports back) that check-cycles enforces.
 */

export { addNode, type AddNodeArgs } from "./add-node.js";
export { moveNode, type MoveNodeArgs } from "./move-node.js";
export { reposition, type RepositionArgs } from "./reposition.js";
export { setContent, type SetContentArgs } from "./set-content.js";
export { RECIPES, type RecipeDescriptor, type RecipeParam } from "./registry.js";
export {
  catalogNamespace, SHARED_CATALOG_NAMESPACE, SHARED_CATALOG_WORKSPACE, CATALOG_ROOT_ID, HOUSE_STYLE_FORMATTER,
  listCatalogEntries, cloneRoutineSubtree, assembleCatalog, useRoutine,
  type CatalogEntry, type CatalogScope, type CatalogKind, type ClonedSubtree, type UseRoutineArgs,
} from "./catalog.js";
export {
  containmentEdgeFor, deriveTemplate, isKnownLabel, orderPathsOf,
  ALIGNMENT_EDGE, POSITION, type NodeTemplate,
} from "./lc.js";
