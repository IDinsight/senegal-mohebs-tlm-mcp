import { createFirebaseStorage } from "./firebase.js";
import { onContextChange } from "../context-state.js";
import type { StorageAdapter, HistoryFile } from "../types.js";

let storage: StorageAdapter | null = null;
export const getStorageAdapter = (): StorageAdapter => (storage ??= createFirebaseStorage());

export let histCache: HistoryFile | null = null;
export function setHistCache(v: HistoryFile | null) { histCache = v; }

// Each grade/subject has its own history.json — drop the cache when switching.
onContextChange(() => { histCache = null; });

export function __setStorageForTest(s: StorageAdapter) {
  storage = s;
  histCache = null;
}
