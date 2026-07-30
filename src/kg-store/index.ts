// Public surface of the kg-store module. External modules import from here;
// siblings import each other directly.
export { getKgStore, __setKgStoreForTest, kgNamespace } from "./adapter.js";
export { createFirestoreKgStore } from "./firestore.js";
export { createMemoryKgStore } from "./memory.js";
export type { KgNodeStore, Slot, StoredNode, StoredEdge, StoredMeta, StoredPointer } from "./types.js";
export { otherSlot } from "./types.js";
export { runGraphMutation, publishDraft, discardDraft, diffGraphs, __resetMutationsForTest } from "./mutations.js";
export type {
  GraphMutation, MutationGraph, MutationNode, MutationEdge, ValidationResult,
  GraphDiff, DiffEntry, GraphPreviewResult, GraphBlockedResult, GraphApplyResult, GraphUnauthorizedResult,
  RunGraphMutationArgs, PublishResult, DiscardResult,
} from "./mutations.js";
export { validateStructural } from "./validate.js";
export { matchesAuditQuery, sortAuditNewestFirst } from "./audit.js";
export type { AuditRecord, AuditQuery, AuditActor, AuditEventType } from "./types.js";
