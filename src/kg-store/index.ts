// Public surface of the kg-store module. External modules import from here;
// siblings import each other directly.
export { getKgStore, __setKgStoreForTest, kgNamespace } from "./adapter.js";
export { createFirestoreKgStore } from "./firestore.js";
export { createMemoryKgStore } from "./memory.js";
export type { KgNodeStore, Slot, StoredNode, StoredEdge, StoredMeta, StoredPointer } from "./types.js";
export { otherSlot, edgeId } from "./types.js";
export { runGraphMutation, publishDraft, discardDraft, diffGraphs, __resetMutationsForTest } from "./mutations.js";
export { diffDraft, publishDraftWithConfirm, discardDraftWithConfirm, __resetDraftTokensForTest } from "./mutations.js";
export { upsertProperty, UPSERT_PROPERTY_SAFE_PATHS } from "./mutations.js";
export { createNode, linkNodes, unlinkNodes, deleteNode, mintNodeId } from "./structural.js";
export type { CreateNodeArgs, LinkNodesArgs, UnlinkNodesArgs, DeleteNodeArgs } from "./structural.js";
export {
  addLesson, addChapter, moveLesson, splitChapter, renumber,
  STRUCTURAL_EDIT_SAFE_PATHS, structuralEditErrors, RECIPES,
} from "./recipes.js";
export type {
  AddLessonArgs, AddChapterArgs, MoveLessonArgs, SplitChapterArgs, RenumberArgs,
  RecipeDescriptor, RecipeParam,
} from "./recipes.js";
export type {
  GraphMutation, MutationGraph, MutationNode, MutationEdge, ValidationResult,
  GraphDiff, DiffEntry, GraphPreviewResult, GraphBlockedResult, GraphApplyResult, GraphUnauthorizedResult,
  RunGraphMutationArgs, PublishResult, DiscardResult,
  WholeDraftDiff, PublishConfirmResult, PublishConfirmPreview, DiscardConfirmResult, DiscardConfirmPreview,
  UpsertPropertyArgs,
} from "./mutations.js";
export { validateStructural, STRUCTURAL_RULES } from "./validate.js";
export { matchesAuditQuery, sortAuditNewestFirst, toAuditActor } from "./audit.js";
export type { AuditRecord, AuditQuery, AuditActor, AuditEventType } from "./types.js";
