/*
 * Public surface of the storage module. Other modules import from here, never
 * from storage/*'s internal files. Firebase wiring and the history cache stay
 * internal (siblings import each other directly within the module).
 */
export { getStorageAdapter, __setStorageForTest } from "./adapter.js";
export { readGlobalObject, writeGlobalObject } from "./firebase.js";
export { extractDocxText } from "./documents.js";
export { listEntries, getEntry, recordContent, reconcile } from "./history.js";
