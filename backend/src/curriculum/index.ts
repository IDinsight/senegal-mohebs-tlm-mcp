/*
 * Public surface of the curriculum module: the normalized-model builder, the
 * FR/Wolof terminology lookups, and the shared bridge that materialises a
 * CurriculumModel from stored nodes+edges. The per-subject raw-graph parsing +
 * projection now lives one directory up in src/adapters/*, so this barrel
 * only exposes the pieces those adapters compose on top of.
 */
export { buildModel, unit } from "./model.js";
export { parseGraph, type GraphParseDescriptor } from "./parse-graph.js";
export { searchTerminology, terminologySections } from "./terminology.js";
export { serializeModel, deserializeToModel, toRawEnvelope, edgeId, PRELOADED_MODEL_KEY, PRELOADED_SLOT_KEY } from "./store-bridge.js";
export { resolvePrune, type PruneStrategySpec } from "./prunes.js";
export { coursesOf, courseSubgraph, standardsFor } from "./courses.js";
export { walkGraph, type WalkArgs, type WalkDirection, type WalkResult } from "./walk.js";
export { computeGraphStats, type GraphStats, type StatsRoot } from "./stats.js";
