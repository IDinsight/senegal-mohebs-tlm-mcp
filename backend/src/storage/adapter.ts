/*
 * Module: storage · internal
 *
 * Holds the single StorageAdapter instance (lazily created) and the in-memory
 * history cache. The adapter is a credential-scoped client, safe to share
 * across sessions; the history cache is context-derived, so it lives in the
 * session bag and is dropped automatically on context switch. Internal to the
 * storage module — other modules go through storage/index.ts.
 */
import { createFirebaseStorage } from "./firebase.js";
import { sessionState } from "../context/index.js";
import type { StorageAdapter, HistoryFile } from "../types.js";

let storage: StorageAdapter | null = null;
export const getStorageAdapter = (): StorageAdapter => (storage ??= createFirebaseStorage());

const HIST_KEY = "storage.histCache";
export const getHistCache = (): HistoryFile | null => (sessionState().bag.get(HIST_KEY) as HistoryFile | undefined) ?? null;
export function setHistCache(v: HistoryFile | null) {
  const { bag } = sessionState();
  if (v === null) bag.delete(HIST_KEY);
  else bag.set(HIST_KEY, v);
}

export function __setStorageForTest(s: StorageAdapter) {
  storage = s;
  setHistCache(null);
}
