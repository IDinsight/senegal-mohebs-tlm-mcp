/*
 * Module: kg-store · internal
 *
 * Lazy singleton for the active KgNodeStore. Firestore init needs credentials
 * and a network call, so we build it on first use — a stdio run that never
 * touches the KG (e.g. only pulling docs from the bucket) doesn't need one.
 * Tests inject a memory store via `__setKgStoreForTest`.
 */
import { createFirestoreKgStore } from "./firestore.js";
import type { KgNodeStore } from "./types.js";

let store: KgNodeStore | null = null;

export function getKgStore(): KgNodeStore {
  return (store ??= createFirestoreKgStore());
}

export function __setKgStoreForTest(s: KgNodeStore | null) { store = s; }

// Convenience: build the current context's namespace key. Kept here (not in
// context/state.ts) so context/ stays a dependency-light leaf.
import { basePrefix } from "../config.js";
export const kgNamespace = (grade: string, subject: string) => `${basePrefix()}${grade}/${subject}`;
