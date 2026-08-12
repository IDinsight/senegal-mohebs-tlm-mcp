// Public surface of the kg-store module. External modules import from here;
// siblings import each other directly.
export { getKgStore, __setKgStoreForTest, kgNamespace } from "./adapter.js";
export { createFirestoreKgStore } from "./firestore.js";
export { createMemoryKgStore } from "./memory.js";
export type { KgNodeStore, Slot, StoredNode, StoredEdge, StoredMeta, StoredPointer } from "./types.js";
export { otherSlot, edgeId } from "./types.js";
export { runGraphMutation, diffGraphs, __resetMutationsForTest } from "./mutations.js";
export { publishDraft, discardDraft, diffDraft, publishDraftWithConfirm, discardDraftWithConfirm, __resetDraftTokensForTest } from "./publish-flow.js";
export { upsertProperty, UPSERT_PROPERTY_SAFE_PATHS, readAtPath, writeAtPath } from "./upsert-property.js";
export { createNode, linkNodes, unlinkNodes, deleteNode, mintNodeId } from "./structural.js";
export type { CreateNodeArgs, LinkNodesArgs, UnlinkNodesArgs, DeleteNodeArgs } from "./structural.js";
// The composite curriculum recipes moved OUT to the `kg-recipes` module (generic
// verbs, no RecipeProfile). kg-store no longer knows them — it exposes only the
// structural primitives + the two-phase framework that kg-recipes composes.
export type {
  GraphMutation, MutationGraph, MutationNode, MutationEdge, ValidationResult,
  GraphDiff, DiffEntry, GraphPreviewResult, GraphBlockedResult, GraphApplyResult, GraphUnauthorizedResult,
  RunGraphMutationArgs,
} from "./mutations.js";
export type {
  PublishResult, DiscardResult,
  WholeDraftDiff, PublishConfirmResult, PublishConfirmPreview, DiscardConfirmResult, DiscardConfirmPreview,
} from "./publish-flow.js";
export type { UpsertPropertyArgs } from "./upsert-property.js";
export { validateStructural, STRUCTURAL_RULES } from "./validate.js";
export { matchesAuditQuery, sortAuditNewestFirst, toAuditActor } from "./audit.js";
export type { AuditRecord, AuditQuery, AuditActor, AuditEventType } from "./types.js";
