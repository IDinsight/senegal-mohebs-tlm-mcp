/*
 * Public surface of the workspaces module: the tenant/membership registry.
 * Subject-agnostic authorization DATA — the app layer reads it to build
 * Actor.memberships, and the workspace-admin tools write it. See
 * docs/design-notes/workspaces.md.
 */
export * from "./types.js";
export {
  getWorkspaceStore,
  __setWorkspaceStoreForTest,
  resolveMemberships,
  createMemoryWorkspaceStore,
} from "./store.js";
