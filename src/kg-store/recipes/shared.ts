// ── Module: kg-store · recipes · internal toolkit ────────────────────────────
// The subject-agnostic primitives the five composite recipes fold together:
// logical-key vocabulary, alias-aware read/write, graph-shaped read helpers, and
// the fresh-node property builder. kg-store never names "chapter"/"lesson"/
// "hasChild"; each recipe reads that vocabulary from a `RecipeProfile` +
// `structuralAliases` + `wordingAliases` threaded through its args (exactly how
// upsert_property receives `wordingAliases`). The server tool layer reads them
// off the active adapter. A subject with no `recipeProfile` simply has no recipes.

import type { MutationGraph, MutationNode } from "../types.js";
import { readAtPath, writeAtPath } from "../upsert-property.js";
import type { WordingAliases, StructuralAliases, RecipeProfile } from "../../types.js";

// Well-known LOGICAL structural/wording key names the recipes reference. The
// adapter's alias maps resolve these to concrete storage paths; the recipe code
// only ever speaks in these conventional names, so kg-store stays subject-blind.
export const K_CHAPTER_NUMBER = "number";        // structuralAliases[chapterKind].number
export const K_LESSON_POSITION = "position";     // structuralAliases[lessonKind].position
// (There is no lesson→chapter number key: chapter membership is the hasChild edge.)
export const W_TITLE = "title";
export const W_TITLE_EN = "title_en";
export const W_TEXT = "text";
export const W_TEXT_EN = "text_en";

// ── Small pure helpers ───────────────────────────────────────────────────────

export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Resolve a logical key to its declared storage paths on a given kind. Returns
// [] when the alias map (or the key on that kind) is absent.
export const aliasPaths = (aliases: WordingAliases | undefined, kind: string, key: string): readonly string[] =>
  aliases?.[kind]?.[key] ?? [];

// Read the value a logical structural/wording key currently holds on a node —
// the first declared path that resolves to a defined value wins (the paths a
// key maps to are kept in sync, so any one of them is authoritative).
export function readLogical(node: MutationNode, kind: string, key: string, aliases: WordingAliases | undefined): unknown {
  for (const p of aliasPaths(aliases, kind, key)) {
    const v = readAtPath(node.properties, p);
    if (v !== undefined) return v;
  }
  return undefined;
}

// Immutably set `value` at every storage path a logical key resolves to.
export function writeLogical(props: Record<string, unknown>, kind: string, key: string, value: unknown, aliases: WordingAliases | undefined): Record<string, unknown> {
  let out = props;
  for (const p of aliasPaths(aliases, kind, key)) out = writeAtPath(out, p, value);
  return out;
}

// ── Graph-shaped read helpers (subject-agnostic via the profile) ─────────────

export const nodeById = (g: MutationGraph, id: string): MutationNode | undefined => g.nodes.find((n) => n.id === id);

// The lesson children of a chapter, via the container (hasChild) EDGE — the
// id-based backbone, not the number. Returned in whatever order the edges list;
// callers that need presentation order sort by `position`.
export function childLessons(g: MutationGraph, chapterId: string, profile: RecipeProfile): MutationNode[] {
  const out: MutationNode[] = [];
  for (const e of g.edges) {
    if (e.type !== profile.containerEdge || e.from !== chapterId) continue;
    const child = nodeById(g, e.to);
    if (child && child.type === profile.lessonKind) out.push(child);
  }
  return out;
}

// The container edges (chapter→lesson) currently pointing AT a lesson, from any
// chapter parent. Normally exactly one; more than one is a multi-parent state
// (#13 warns on it). Used by move_lesson to detach the lesson from all its
// current chapter parents before relinking.
export function chapterParentEdgeIds(g: MutationGraph, lessonId: string, profile: RecipeProfile): string[] {
  const ids: string[] = [];
  for (const e of g.edges) {
    if (e.type !== profile.containerEdge || e.to !== lessonId) continue;
    const parent = nodeById(g, e.from);
    if (parent && parent.type === profile.chapterKind) ids.push(e.id);
  }
  return ids;
}

export const chapterNumberOf = (chapter: MutationNode, profile: RecipeProfile, sAliases: StructuralAliases): number | null =>
  asNum(readLogical(chapter, profile.chapterKind, K_CHAPTER_NUMBER, sAliases));

export const positionOf = (lesson: MutationNode, profile: RecipeProfile, sAliases: StructuralAliases): number =>
  asNum(readLogical(lesson, profile.lessonKind, K_LESSON_POSITION, sAliases)) ?? 0;

// The set of numbers already taken by chapters — so add_chapter / renumber can
// reject a colliding number (the additive/free-number paths; #14 decisions (c)/(1)).
export function usedChapterNumbers(g: MutationGraph, profile: RecipeProfile, sAliases: StructuralAliases, exceptId?: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const n of g.nodes) {
    if (n.type !== profile.chapterKind || n.id === exceptId) continue;
    const num = chapterNumberOf(n, profile, sAliases);
    if (num != null) m.set(num, n.id);
  }
  return m;
}

// Next free chapter number when appending (split default, #14 decision: append
// at max+1 to avoid shifting existing chapters).
export function nextChapterNumber(g: MutationGraph, profile: RecipeProfile, sAliases: StructuralAliases): number {
  let max = 0;
  for (const num of usedChapterNumbers(g, profile, sAliases).keys()) if (num > max) max = num;
  return max + 1;
}

// Build a fresh node's `properties` by folding wording + structural + flag sets.
// Each set names (aliasMap, key, value); an undefined value is skipped so an
// absent optional (e.g. no title_en) leaves no key behind (Firestore rejects
// `undefined`). The assessment flag is written to its literal profile path.
export type PropSet = { aliases: WordingAliases; kind: string; key: string; value: unknown };
export function buildProps(sets: PropSet[], flags: Array<{ path: string; value: unknown }>): Record<string, unknown> {
  let props: Record<string, unknown> = { raw: {} };
  for (const s of sets) {
    if (s.value === undefined) continue;
    props = writeLogical(props, s.kind, s.key, s.value, s.aliases);
  }
  for (const f of flags) {
    if (f.value === undefined) continue;
    props = writeAtPath(props, f.path, f.value);
  }
  return props;
}

// ── Shared arg shape ─────────────────────────────────────────────────────────
// Every recipe carries the subject vocabulary its server tool read off the
// active adapter, plus the namespace. Recipe-specific fields extend this.
export type RecipeCommon = {
  namespace: string;
  profile: RecipeProfile;
  structuralAliases: StructuralAliases;
  wordingAliases: WordingAliases;
};
