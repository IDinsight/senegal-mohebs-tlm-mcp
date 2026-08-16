/*
 * Public surface of the kg-store module. External modules import from here;
 * siblings import each other directly.
 */
export { getKgStore, __setKgStoreForTest, kgNamespace, parseNamespace } from "./adapter.js";
export { createFirestoreKgStore } from "./firestore.js";
export { createMemoryKgStore } from "./memory.js";
export type { KgNodeStore, Slot, StoredNode, StoredEdge, StoredMeta, StoredConfig, StoredPointer } from "./types.js";
export { otherSlot, edgeId } from "./types.js";
export { runGraphMutation, diffGraphs, __resetMutationsForTest } from "./mutations.js";
export { publishDraft, discardDraft, diffDraft, publishDraftWithConfirm, discardDraftWithConfirm, __resetDraftTokensForTest } from "./publish-flow.js";
export { editProfileWithConfirm, diffProfile, hashConfig, __resetConfigTokensForTest } from "./config-flow.js";
export type { EditProfileResult, EditProfileOpts, ConfigDiff, WholeDraftProfileDiff } from "./config-flow.js";
export { readAtPath, writeAtPath } from "./paths.js";
export { createNode, linkNodes, unlinkNodes, deleteNode, deleteEdges, deleteNodes, mintNodeId } from "./structural.js";
export type { CreateNodeArgs, LinkNodesArgs, UnlinkNodesArgs, DeleteNodeArgs, DeleteEdgesArgs, DeleteNodesArgs } from "./structural.js";
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
export { validateStructural, STRUCTURAL_RULES } from "./validate.js";
export { matchesAuditQuery, sortAuditNewestFirst, toAuditActor } from "./audit.js";
export type { AuditRecord, AuditQuery, AuditActor, AuditEventType } from "./types.js";
