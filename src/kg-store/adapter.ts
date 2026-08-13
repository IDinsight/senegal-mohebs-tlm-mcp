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

// Build a context's namespace key. Workspace is the top segment so two
// workspaces can share a (grade, subject) without colliding (see
// docs/design-notes/workspaces.md). Kept here (not in context/state.ts) so
// context/ stays a dependency-light leaf.
//
// Two forms:
//   kgNamespace(workspace, grade, subject)  — the real, tenant-explicit key.
//   kgNamespace(grade, subject)             — single-tenant convenience that
//     defaults the workspace to DEFAULT_WORKSPACE. For tests / legacy callers
//     only; every PRODUCTION site passes the workspace explicitly so the
//     tenant boundary is never implicit on a live path.
import { basePrefix, DEFAULT_WORKSPACE } from "../config.js";
export function kgNamespace(workspace: string, grade: string, subject: string): string;
export function kgNamespace(grade: string, subject: string): string;
export function kgNamespace(a: string, b: string, c?: string): string {
  const [workspace, grade, subject] = c === undefined ? [DEFAULT_WORKSPACE, a, b] : [a, b, c];
  return `${basePrefix()}${workspace}/${grade}/${subject}`;
}
