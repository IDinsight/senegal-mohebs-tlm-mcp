// Public surface of the kg-store module. External modules import from here;
// siblings import each other directly.
export { getKgStore, __setKgStoreForTest, kgNamespace } from "./adapter.js";
export { createFirestoreKgStore } from "./firestore.js";
export { createMemoryKgStore } from "./memory.js";
export type { KgNodeStore, Slot, StoredNode, StoredEdge, StoredMeta, StoredPointer } from "./types.js";
export { otherSlot } from "./types.js";
export { runGraphMutation, diffGraphs, __resetMutationsForTest } from "./mutations.js";
export type {
  GraphMutation, MutationGraph, MutationNode, MutationEdge, ValidationResult,
  GraphDiff, DiffEntry, GraphPreviewResult, GraphBlockedResult, GraphApplyResult,
  RunGraphMutationArgs,
} from "./mutations.js";
