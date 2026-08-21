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

// Reserved grade segments that name a workspace-scoped PARTITION, not a teaching
// context: the catalog (`_catalog`) and the bilingual lexicon (`_glossary`).
// parseNamespace rejects these so they never appear as a selectable context
// (set_context) or as a browsable graph in the explorer's namespace picker.
const RESERVED_GRADES = new Set(["_catalog", "_glossary"]);

// Inverse of kgNamespace: recover the teaching context a namespace names. Strips
// the bucket prefix and splits into workspace/grade/subject. Returns null for
// anything that isn't a 3-segment curriculum namespace — notably the reserved
// partitions above, which are not teaching contexts.
export function parseNamespace(ns: string): { workspace: string; grade: string; subject: string } | null {
  const prefix = basePrefix();
  const body = prefix && ns.startsWith(prefix) ? ns.slice(prefix.length) : ns;
  const parts = body.split("/");
  if (parts.length !== 3) return null;
  const [workspace, grade, subject] = parts;
  if (RESERVED_GRADES.has(grade)) return null;
  return { workspace, grade, subject };
}
