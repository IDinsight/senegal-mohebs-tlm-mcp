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
import type { WordingAliases, StructuralAliases, RecipeProfile, LcNodeTemplate } from "../../types.js";

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

// ── LC identity stamping (faithful re-export) ────────────────────────────────
// A created node must carry the raw LC identity fields — else it is a "half"
// node the LC parser would drop on a re-parse. The adapter declares them per
// kind as an `LcNodeTemplate`; kg-store stays subject-blind by reading that
// template (never naming "domaine"/"subtopic" itself).

// The node's display title — a Standard Grouping (chapter/domaine/week) keeps
// its name in normalized `title`, mirrored in `raw.description`. Read either.
const titleOf = (n: MutationNode): string | null => {
  const t = readAtPath(n.properties, "title");
  if (typeof t === "string" && t) return t;
  const d = readAtPath(n.properties, "raw.description");
  return typeof d === "string" && d ? d : null;
};

// The container-parents (hasChild sources) pointing AT a node — a node may have
// several axes (a lesson has a chapter AND a week parent), so return all.
function containerParents(g: MutationGraph, childId: string, containerEdge: string): MutationNode[] {
  const out: MutationNode[] = [];
  for (const e of g.edges) {
    if (e.type !== containerEdge || e.to !== childId) continue;
    const p = nodeById(g, e.from);
    if (p) out.push(p);
  }
  return out;
}

// Resolve the `statement_type` to stamp on a node of `kind` being placed under
// `containerParentId`. A constant declaration returns as-is; an inherit
// declaration climbs container-ancestors for a node of the named kind and takes
// its title (a maths lesson's strand = its domaine's name), then falls back to
// copying an existing sibling's raw.statement_type, then to null (leave blank).
export function resolveStatementType(
  g: MutationGraph,
  containerParentId: string | null,
  kind: string,
  template: LcNodeTemplate | undefined,
  containerEdge: string,
): string | null {
  const decl = template?.[kind]?.statementType;
  if (decl == null) return null;
  if (typeof decl === "string") return decl;

  // Inherit: breadth-first climb of container-ancestors from the placement
  // parent, looking for a node of the target kind; take its title.
  if (containerParentId) {
    const target = decl.inheritTitleFromAncestorKind;
    const seen = new Set<string>();
    let frontier = [containerParentId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const node = nodeById(g, id);
        if (!node) continue;
        if (node.type === target) { const t = titleOf(node); if (t) return t; }
        for (const p of containerParents(g, id, containerEdge)) next.push(p.id);
      }
      frontier = next;
    }
    // Fallback: copy from an existing sibling of the same kind under the parent.
    for (const e of g.edges) {
      if (e.type !== containerEdge || e.from !== containerParentId) continue;
      const sib = nodeById(g, e.to);
      if (sib && sib.type === kind) {
        const st = readAtPath(sib.properties, "raw.statement_type");
        if (typeof st === "string" && st) return st;
      }
    }
  }
  return null;
}

// Stamp the LC identity fields (role / normalized_statement_type / statement_type)
// into a fresh node's `properties`. `statementType` is pre-resolved by the
// caller (via resolveStatementType) so this stays a pure write. A null/blank
// statement_type is skipped, leaving the field unset for the reviewer to fill.
export function stampLcProps(
  props: Record<string, unknown>,
  kind: string,
  template: LcNodeTemplate | undefined,
  statementType: string | null,
): Record<string, unknown> {
  const t = template?.[kind];
  if (!t) return props;
  let out = props;
  if (t.role !== undefined) out = writeAtPath(out, "raw.metadata.role", t.role);
  if (t.normalizedStatementType !== undefined) out = writeAtPath(out, "raw.normalized_statement_type", t.normalizedStatementType);
  if (statementType != null && statementType !== "") out = writeAtPath(out, "raw.statement_type", statementType);
  return out;
}

// The labels to stamp on a created node of `kind` (or undefined if none).
export const lcLabels = (kind: string, template: LcNodeTemplate | undefined): string[] | undefined => template?.[kind]?.labels;

// ── Shared arg shape ─────────────────────────────────────────────────────────
// Every recipe carries the subject vocabulary its server tool read off the
// active adapter, plus the namespace. Recipe-specific fields extend this.
export type RecipeCommon = {
  namespace: string;
  profile: RecipeProfile;
  structuralAliases: StructuralAliases;
  wordingAliases: WordingAliases;
  lcNodeTemplate?: LcNodeTemplate;   // LC identity fields to stamp on created nodes; absent = pre-#labels behavior
};
