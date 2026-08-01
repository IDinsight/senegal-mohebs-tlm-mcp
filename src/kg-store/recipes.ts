// ── Module: kg-store · internal ──────────────────────────────────────────────
// Curriculum RECIPES (#14) — named, curriculum-meaningful COMPOSITE operations.
// Each recipe is a SINGLE #5 GraphMutation whose `apply` performs many
// create/link/unlink + structural-property edits internally and atomically, so
// one intent → one whole-composite diff → one confirmation token → one atomic
// draft write → one #7 audit event → gated by #8. Recipes are the ergonomic
// layer OVER the #12 primitives, made safe by #13's full integrity floor:
//
//   • They REUSE #12's pure primitive `apply` functions (createNode / linkNodes
//     / unlinkNodes) by composing them — a recipe is literally several
//     primitives folded together, never Claude orchestrating separate tool
//     calls (which would reintroduce confirmation fatigue + partial-draft risk).
//   • The framework runs #13's `validateStructural` (Rule 1 id-immutable,
//     Rule 2 no-orphan) on the WHOLE resulting draft — an invalid composite
//     (e.g. a move that would dangle an edge) is rejected as a WHOLE, nothing
//     partial lands. Each recipe adds its own preflight `validate` for the
//     curriculum-level preconditions the structural rules can't see (target is
//     a chapter, number is free, …).
//   • Coverage WARNINGS (#13) ride the normal preview envelope — a split that
//     leaves a chapter without a bilan warns, never blocks.
//
// ── The Regime-B fact that shapes move/split/renumber (from #13) ──────────────
// The CI maths *presenter* joins a lesson to its chapter by matching
// `raw.chapitreNum`, NOT by the `hasChild` edge. That number is a DENORMALIZED
// copy of the (Rule-2-guarded) edge. #13 resolved its drift as a WARNING, not a
// block. So a recipe that rewires the hasChild edge but leaves `raw.chapitreNum`
// stale would leave the moved lesson rendering under its OLD chapter (and fire
// the drift warning). Therefore move_lesson / split_chapter / renumber all
// rewrite `raw.chapitreNum` on the affected lessons as part of the SAME atomic
// composite — the recipe's own cascade is what keeps the presentation correct;
// Rule 2 only blocks genuine EDGE dangling, which a property edit never causes.
// This is why all three share the structural-property edit path below.
//
// Subject-agnosticism: kg-store never names "chapter"/"lesson"/"hasChild". Each
// recipe reads that vocabulary from a `RecipeProfile` + `structuralAliases` +
// `wordingAliases` threaded through its args (exactly how upsert_property
// receives `wordingAliases`). The server tool layer reads them off the active
// adapter. A subject with no `recipeProfile` simply has no recipes.

import { edgeId } from "./types.js";
import type { MutationGraph, MutationNode } from "./types.js";
import type { GraphMutation } from "./mutations.js";
import { readAtPath, writeAtPath } from "./upsert-property.js";
import { createNode, linkNodes, unlinkNodes } from "./structural.js";
import type { WordingAliases, StructuralAliases, RecipeProfile } from "../types.js";

// ── The structural-property edit path (#14 foundation) ───────────────────────
// The curated set of STRUCTURAL storage paths a recipe may write on an EXISTING
// node — the analogue of #10's UPSERT_PROPERTY_SAFE_PATHS, kept separate so the
// two editable surfaces never blur (wording is #10; structure is here). An
// adapter's `structuralAliases` MUST resolve only to paths in this set — if it
// declares anything else, `structuralEditErrors` rejects the edit, so safety
// never relies on an adapter being careful.
export const STRUCTURAL_EDIT_SAFE_PATHS: ReadonlySet<string> = new Set([
  "order",           // normalized ordering (chapter number / lesson within-chapter position)
  "raw.chapitreNum", // CI maths: chapter number + the lesson→chapter join key (Regime-B)
  "raw.leconNum",    // CI maths: lesson within-chapter number
]);

// Well-known LOGICAL structural/wording key names the recipes reference. The
// adapter's alias maps resolve these to concrete storage paths; the recipe code
// only ever speaks in these conventional names, so kg-store stays subject-blind.
const K_CHAPTER_NUMBER = "number";        // structuralAliases[chapterKind].number
const K_LESSON_CHAPTER = "chapterNumber"; // structuralAliases[lessonKind].chapterNumber
const K_LESSON_POSITION = "position";     // structuralAliases[lessonKind].position
const W_TITLE = "title";
const W_TITLE_EN = "title_en";
const W_TEXT = "text";
const W_TEXT_EN = "text_en";

// ── Small pure helpers ───────────────────────────────────────────────────────

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Resolve a logical key to its declared storage paths on a given kind. Returns
// [] when the alias map (or the key on that kind) is absent.
const aliasPaths = (aliases: WordingAliases | undefined, kind: string, key: string): readonly string[] =>
  aliases?.[kind]?.[key] ?? [];

// Read the value a logical structural/wording key currently holds on a node —
// the first declared path that resolves to a defined value wins (the paths a
// key maps to are kept in sync, so any one of them is authoritative).
function readLogical(node: MutationNode, kind: string, key: string, aliases: WordingAliases | undefined): unknown {
  for (const p of aliasPaths(aliases, kind, key)) {
    const v = readAtPath(node.properties, p);
    if (v !== undefined) return v;
  }
  return undefined;
}

// Immutably set `value` at every storage path a logical key resolves to.
function writeLogical(props: Record<string, unknown>, kind: string, key: string, value: unknown, aliases: WordingAliases | undefined): Record<string, unknown> {
  let out = props;
  for (const p of aliasPaths(aliases, kind, key)) out = writeAtPath(out, p, value);
  return out;
}

// Apply a STRUCTURAL edit to one existing node in `nodes`, returning a new
// nodes array. Pure; assumes the edit has already been validated (see
// `structuralEditErrors`). A no-op when the node or the key's paths are absent.
function editStructural(nodes: MutationNode[], nodeId: string, key: string, value: number, sAliases: StructuralAliases): MutationNode[] {
  return nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const props = writeLogical(n.properties, n.type, key, value, sAliases);
    return { ...n, properties: props };
  });
}

// The validation half of the structural-property edit path — used by each
// recipe's own `validate`. Confirms: the node exists; the key is declared for
// its kind; every resolved path is on the central safety allowlist; and the
// key currently holds a number on the node (structure edits change existing
// numbers, they don't invent fields — the same "existing key" discipline #10
// applies to wording).
export function structuralEditErrors(node: MutationNode | undefined, nodeId: string, key: string, sAliases: StructuralAliases): string[] {
  const errors: string[] = [];
  if (!node) return [`structural edit: node '${nodeId}' not found in the draft.`];
  const paths = aliasPaths(sAliases, node.type, key);
  if (paths.length === 0) {
    errors.push(`structural edit: key '${key}' is not editable on node kind '${node.type}' (the adapter declares no structuralAliases for it).`);
    return errors;
  }
  for (const p of paths) {
    if (!STRUCTURAL_EDIT_SAFE_PATHS.has(p))
      errors.push(`structural edit: storage path '${p}' (for key '${key}' on kind '${node.type}') is not on the structural safety allowlist. Extend STRUCTURAL_EDIT_SAFE_PATHS to allow it.`);
  }
  if (errors.length > 0) return errors;
  for (const p of paths) {
    const cur = readAtPath(node.properties, p);
    if (typeof cur !== "number")
      errors.push(`structural edit: path '${p}' does not currently hold a number on node '${nodeId}' (current: ${cur === undefined ? "missing" : JSON.stringify(cur)}). Recipes edit existing structural numbers; they do not create the field.`);
  }
  return errors;
}

// ── Graph-shaped read helpers (subject-agnostic via the profile) ─────────────

const nodeById = (g: MutationGraph, id: string): MutationNode | undefined => g.nodes.find((n) => n.id === id);

// The lesson children of a chapter, via the container (hasChild) EDGE — the
// id-based backbone, not the number. Returned in whatever order the edges list;
// callers that need presentation order sort by `position`.
function childLessons(g: MutationGraph, chapterId: string, profile: RecipeProfile): MutationNode[] {
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
function chapterParentEdgeIds(g: MutationGraph, lessonId: string, profile: RecipeProfile): string[] {
  const ids: string[] = [];
  for (const e of g.edges) {
    if (e.type !== profile.containerEdge || e.to !== lessonId) continue;
    const parent = nodeById(g, e.from);
    if (parent && parent.type === profile.chapterKind) ids.push(e.id);
  }
  return ids;
}

const chapterNumberOf = (chapter: MutationNode, profile: RecipeProfile, sAliases: StructuralAliases): number | null =>
  asNum(readLogical(chapter, profile.chapterKind, K_CHAPTER_NUMBER, sAliases));

const positionOf = (lesson: MutationNode, profile: RecipeProfile, sAliases: StructuralAliases): number =>
  asNum(readLogical(lesson, profile.lessonKind, K_LESSON_POSITION, sAliases)) ?? 0;

// The set of numbers already taken by chapters — so add_chapter / renumber can
// reject a colliding number (the additive/free-number paths; #14 decisions (c)/(1)).
function usedChapterNumbers(g: MutationGraph, profile: RecipeProfile, sAliases: StructuralAliases, exceptId?: string): Map<number, string> {
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
function nextChapterNumber(g: MutationGraph, profile: RecipeProfile, sAliases: StructuralAliases): number {
  let max = 0;
  for (const num of usedChapterNumbers(g, profile, sAliases).keys()) if (num > max) max = num;
  return max + 1;
}

// Build a fresh node's `properties` by folding wording + structural + flag sets.
// Each set names (aliasMap, key, value); an undefined value is skipped so an
// absent optional (e.g. no title_en) leaves no key behind (Firestore rejects
// `undefined`). The assessment flag is written to its literal profile path.
type PropSet = { aliases: WordingAliases; kind: string; key: string; value: unknown };
function buildProps(sets: PropSet[], flags: Array<{ path: string; value: unknown }>): Record<string, unknown> {
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
type RecipeCommon = {
  namespace: string;
  profile: RecipeProfile;
  structuralAliases: StructuralAliases;
  wordingAliases: WordingAliases;
};

// ── Recipe 1: add_lesson ──────────────────────────────────────────────────────
// Create a lesson node + link it (hasChild) to an EXISTING chapter, as one
// composite. Additive. The new lesson's `chapterNumber` (raw.chapitreNum) is set
// to the target chapter's number so the CI maths view joins it correctly — an
// add_lesson that skipped this would create an immediately-drifting lesson.
export type AddLessonArgs = RecipeCommon & {
  chapterId: string;
  lessonId: string;       // minted by the tool layer
  text: string;
  text_en?: string;
  order?: number;
  isBilan?: boolean;
};

export const addLesson: GraphMutation<AddLessonArgs> = {
  name: "addLesson",
  describe: (a) => `add a lesson to chapter '${a.chapterId}'`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const chapter = nodeById(base, a.chapterId);
    if (!chapter) errors.push(`add_lesson: chapter '${a.chapterId}' does not exist in the draft.`);
    else if (chapter.type !== a.profile.chapterKind) errors.push(`add_lesson: node '${a.chapterId}' is a '${chapter.type}', not a ${a.profile.chapterKind}.`);
    else if (chapterNumberOf(chapter, a.profile, a.structuralAliases) == null) errors.push(`add_lesson: chapter '${a.chapterId}' has no numeric ${K_CHAPTER_NUMBER} — cannot derive the new lesson's chapter-membership number.`);
    if (typeof a.text !== "string" || a.text.length === 0) errors.push(`add_lesson: 'text' (the lesson objective) is required.`);
    if (base.nodes.some((n) => n.id === a.lessonId)) errors.push(`add_lesson: minted lesson id '${a.lessonId}' already exists (retry).`);
    return { errors, warnings };
  },
  apply: (base, a) => {
    // apply runs BEFORE validate in the dry-run — guard the missing-chapter
    // case so a bad chapterId yields a clean "blocked" (validate) rather than a
    // throw. A no-op `after` diffs to nothing; validate blocks the token anyway.
    const chapter = nodeById(base, a.chapterId);
    if (!chapter) return base;
    const num = chapterNumberOf(chapter, a.profile, a.structuralAliases) ?? 0;
    const siblings = childLessons(base, a.chapterId, a.profile);
    const position = a.order ?? (siblings.reduce((m, l) => Math.max(m, positionOf(l, a.profile, a.structuralAliases)), 0) + 1);
    const properties = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT, value: a.text },
        { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT_EN, value: a.text_en },
        { aliases: a.structuralAliases, kind: a.profile.lessonKind, key: K_LESSON_CHAPTER, value: num },
        { aliases: a.structuralAliases, kind: a.profile.lessonKind, key: K_LESSON_POSITION, value: position },
      ],
      [{ path: a.profile.assessmentProperty, value: a.isBilan ?? false }],
    );
    let g = createNode.apply(base, { kind: a.profile.lessonKind, properties, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.lessonId });
    g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.chapterId, toId: a.lessonId, properties: { orderInParent: position }, namespace: a.namespace });
    return g;
  },
};

// ── Recipe 2: add_chapter ─────────────────────────────────────────────────────
// Create a chapter (wording + number at birth) + optional seed lessons (each
// created + linked), as one composite. The number must be FREE — append or
// fill a gap (#14 decision (c)). A colliding number is rejected here; inserting
// BETWEEN existing chapters (which would shift their numbers) is the separate,
// explicit renumber-bearing path, never this additive one.
export type AddChapterArgs = RecipeCommon & {
  chapterId: string;                                    // minted
  number: number;
  title: string;
  title_en?: string;
  lessons?: Array<{ text: string; text_en?: string; isBilan?: boolean }>;
  lessonIds: string[];                                  // minted, aligned with `lessons`
};

export const addChapter: GraphMutation<AddChapterArgs> = {
  name: "addChapter",
  describe: (a) => `add chapter ${a.number} ('${a.title}')${a.lessons?.length ? ` with ${a.lessons.length} lesson(s)` : ""}`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (asNum(a.number) == null) errors.push(`add_chapter: 'number' must be a finite number.`);
    else {
      const used = usedChapterNumbers(base, a.profile, a.structuralAliases);
      if (used.has(a.number)) errors.push(`add_chapter: chapter number ${a.number} is already used by '${used.get(a.number)}'. The additive path needs a FREE number (append or fill a gap); to insert between chapters and shift the rest, use renumber.`);
    }
    if (typeof a.title !== "string" || a.title.length === 0) warnings.push(`add_chapter: chapter created without a title — set one before publishing.`);
    if (base.nodes.some((n) => n.id === a.chapterId)) errors.push(`add_chapter: minted chapter id '${a.chapterId}' already exists (retry).`);
    const lessons = a.lessons ?? [];
    if ((a.lessonIds?.length ?? 0) !== lessons.length) errors.push(`add_chapter: minted lesson id count (${a.lessonIds?.length ?? 0}) does not match seed lesson count (${lessons.length}) — tool-layer wiring bug.`);
    lessons.forEach((l, i) => { if (typeof l.text !== "string" || l.text.length === 0) errors.push(`add_chapter: seed lesson #${i + 1} has no 'text'.`); });
    return { errors, warnings };
  },
  apply: (base, a) => {
    const chapterProps = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE, value: a.title },
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE_EN, value: a.title_en },
        { aliases: a.structuralAliases, kind: a.profile.chapterKind, key: K_CHAPTER_NUMBER, value: a.number },
      ],
      [],
    );
    let g = createNode.apply(base, { kind: a.profile.chapterKind, properties: chapterProps, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.chapterId });
    (a.lessons ?? []).forEach((l, i) => {
      const lessonId = a.lessonIds[i];
      const position = i + 1;
      const props = buildProps(
        [
          { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT, value: l.text },
          { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT_EN, value: l.text_en },
          { aliases: a.structuralAliases, kind: a.profile.lessonKind, key: K_LESSON_CHAPTER, value: a.number },
          { aliases: a.structuralAliases, kind: a.profile.lessonKind, key: K_LESSON_POSITION, value: position },
        ],
        [{ path: a.profile.assessmentProperty, value: l.isBilan ?? false }],
      );
      g = createNode.apply(g, { kind: a.profile.lessonKind, properties: props, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: lessonId });
      g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.chapterId, toId: lessonId, properties: { orderInParent: position }, namespace: a.namespace });
    });
    return g;
  },
};

// ── Recipe 3: move_lesson ─────────────────────────────────────────────────────
// Unlink a lesson from its current chapter, link it (hasChild) to another, and
// rewrite its chapter-membership number so it renders under the new chapter.
// Numbers are preserved (#14 decision (b)): the lesson's within-chapter position
// defaults to appending at the tail of the target; pass `position` to place it.
export type MoveLessonArgs = RecipeCommon & {
  lessonId: string;
  toChapterId: string;
  position?: number;
};

export const moveLesson: GraphMutation<MoveLessonArgs> = {
  name: "moveLesson",
  describe: (a) => `move lesson '${a.lessonId}' to chapter '${a.toChapterId}'`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const lesson = nodeById(base, a.lessonId);
    const toChapter = nodeById(base, a.toChapterId);
    if (!lesson) errors.push(`move_lesson: lesson '${a.lessonId}' does not exist in the draft.`);
    else if (lesson.type !== a.profile.lessonKind) errors.push(`move_lesson: node '${a.lessonId}' is a '${lesson.type}', not a ${a.profile.lessonKind}.`);
    if (!toChapter) errors.push(`move_lesson: target chapter '${a.toChapterId}' does not exist in the draft.`);
    else if (toChapter.type !== a.profile.chapterKind) errors.push(`move_lesson: target '${a.toChapterId}' is a '${toChapter.type}', not a ${a.profile.chapterKind}.`);
    else if (chapterNumberOf(toChapter, a.profile, a.structuralAliases) == null) errors.push(`move_lesson: target chapter '${a.toChapterId}' has no numeric ${K_CHAPTER_NUMBER}.`);
    if (lesson && toChapter) {
      const parents = chapterParentEdgeIds(base, a.lessonId, a.profile);
      if (parents.length === 0) errors.push(`move_lesson: lesson '${a.lessonId}' is not linked to any chapter — nothing to move.`);
      if (parents.includes(edgeId(a.profile.containerEdge, a.toChapterId, a.lessonId))) errors.push(`move_lesson: lesson '${a.lessonId}' is already in chapter '${a.toChapterId}'.`);
    }
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    // apply precedes validate; a missing lesson/target must not throw here.
    const lesson = nodeById(base, a.lessonId);
    const toChapter = nodeById(base, a.toChapterId);
    if (!lesson || !toChapter) return base;
    let g: MutationGraph = base;
    // Detach from every current chapter parent (normally one; more than one is
    // the multi-parent state #13 warns on — moving cleans it up as a side effect).
    for (const id of chapterParentEdgeIds(g, a.lessonId, a.profile)) g = unlinkNodes.apply(g, { edgeId: id });
    const num = chapterNumberOf(toChapter, a.profile, a.structuralAliases) ?? 0;
    const siblings = childLessons(g, a.toChapterId, a.profile);
    const position = a.position ?? (siblings.reduce((m, l) => Math.max(m, positionOf(l, a.profile, a.structuralAliases)), 0) + 1);
    g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.toChapterId, toId: a.lessonId, properties: { orderInParent: position }, namespace: a.namespace });
    // Rewrite the moved lesson: chapter-membership number (mandatory, Regime-B)
    // + within-chapter position.
    g = { nodes: editStructural(g.nodes, a.lessonId, K_LESSON_CHAPTER, num, a.structuralAliases), edges: g.edges };
    g = { nodes: editStructural(g.nodes, a.lessonId, K_LESSON_POSITION, position, a.structuralAliases), edges: g.edges };
    return g;
  },
};

// ── Recipe 4: split_chapter ───────────────────────────────────────────────────
// Create a new chapter and MOVE the tail lessons (from `atLessonId` onward, in
// presentation order) to it — unlink old hasChild, link new, rewrite each moved
// lesson's chapter-membership number. The new chapter is APPENDED at the next
// free number by default (#14 decision: no shift of existing chapters); pass a
// free `newNumber` to place it in a gap. Within-chapter positions are preserved.
export type SplitChapterArgs = RecipeCommon & {
  chapterId: string;
  atLessonId: string;
  newChapterId: string;    // minted
  newTitle?: string;
  newTitle_en?: string;
  newNumber?: number;
};

// The effective new-chapter number — the shared pure fn both validate and apply
// use so they never disagree (append at max+1 unless a free number is given).
function splitNumber(base: MutationGraph, a: SplitChapterArgs): number {
  return a.newNumber ?? nextChapterNumber(base, a.profile, a.structuralAliases);
}

export const splitChapter: GraphMutation<SplitChapterArgs> = {
  name: "splitChapter",
  describe: (a) => `split chapter '${a.chapterId}' at lesson '${a.atLessonId}' into a new chapter`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const chapter = nodeById(base, a.chapterId);
    if (!chapter) { errors.push(`split_chapter: chapter '${a.chapterId}' does not exist.`); return { errors, warnings: [] }; }
    if (chapter.type !== a.profile.chapterKind) errors.push(`split_chapter: node '${a.chapterId}' is a '${chapter.type}', not a ${a.profile.chapterKind}.`);
    const lessons = childLessons(base, a.chapterId, a.profile).sort((x, y) => positionOf(x, a.profile, a.structuralAliases) - positionOf(y, a.profile, a.structuralAliases));
    const at = lessons.findIndex((l) => l.id === a.atLessonId);
    if (at < 0) errors.push(`split_chapter: lesson '${a.atLessonId}' is not a lesson of chapter '${a.chapterId}'.`);
    if (base.nodes.some((n) => n.id === a.newChapterId)) errors.push(`split_chapter: minted chapter id '${a.newChapterId}' already exists (retry).`);
    if (a.newNumber !== undefined) {
      if (asNum(a.newNumber) == null) errors.push(`split_chapter: 'newNumber' must be a finite number.`);
      else {
        const used = usedChapterNumbers(base, a.profile, a.structuralAliases);
        if (used.has(a.newNumber)) errors.push(`split_chapter: newNumber ${a.newNumber} is already used by '${used.get(a.newNumber)}'. Choose a free number, or omit newNumber to append at the end.`);
      }
    }
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    const source = nodeById(base, a.chapterId);
    if (!source) return base; // apply precedes validate; missing chapter → no-op
    const effNum = splitNumber(base, a);
    const sourceTitle = readLogical(source, a.profile.chapterKind, W_TITLE, a.wordingAliases);
    const newTitle = a.newTitle ?? (typeof sourceTitle === "string" ? `${sourceTitle} (suite)` : "");
    const chapterProps = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE, value: newTitle },
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE_EN, value: a.newTitle_en },
        { aliases: a.structuralAliases, kind: a.profile.chapterKind, key: K_CHAPTER_NUMBER, value: effNum },
      ],
      [],
    );
    let g = createNode.apply(base, { kind: a.profile.chapterKind, properties: chapterProps, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.newChapterId });

    const lessons = childLessons(base, a.chapterId, a.profile).sort((x, y) => positionOf(x, a.profile, a.structuralAliases) - positionOf(y, a.profile, a.structuralAliases));
    const at = lessons.findIndex((l) => l.id === a.atLessonId);
    const tail = at < 0 ? [] : lessons.slice(at);
    tail.forEach((lesson, i) => {
      g = unlinkNodes.apply(g, { edgeId: edgeId(a.profile.containerEdge, a.chapterId, lesson.id) });
      g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.newChapterId, toId: lesson.id, properties: { orderInParent: positionOf(lesson, a.profile, a.structuralAliases) || i + 1 }, namespace: a.namespace });
      // Rewrite ONLY the chapter-membership number — within-chapter positions
      // are preserved (#14 decision (b): renumber only when explicitly asked).
      g = { nodes: editStructural(g.nodes, lesson.id, K_LESSON_CHAPTER, effNum, a.structuralAliases), edges: g.edges };
    });
    return g;
  },
};

// ── Recipe 5: renumber ────────────────────────────────────────────────────────
// Structural-property edit of a chapter's number — the ONE recipe whose safety
// is fully determined by the #13 regime finding. It rewrites the chapter's
// `number` (order + raw.chapitreNum) AND cascade-rewrites every child lesson's
// chapter-membership number (raw.chapitreNum) in the SAME atomic composite, so
// the family stays consistent and no `chapitreNum` drift warning fires. The
// target number must be FREE (#14 decision (1)) — renumber MOVES a chapter to an
// unoccupied number; it does not shift or swap other chapters.
export type RenumberArgs = RecipeCommon & {
  chapterId: string;
  newNumber: number;
};

export const renumber: GraphMutation<RenumberArgs> = {
  name: "renumber",
  describe: (a) => `renumber chapter '${a.chapterId}' to ${a.newNumber}`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const chapter = nodeById(base, a.chapterId);
    if (!chapter) { errors.push(`renumber: chapter '${a.chapterId}' does not exist in the draft.`); return { errors, warnings: [] }; }
    if (chapter.type !== a.profile.chapterKind) { errors.push(`renumber: node '${a.chapterId}' is a '${chapter.type}', not a ${a.profile.chapterKind}.`); return { errors, warnings: [] }; }
    if (asNum(a.newNumber) == null) { errors.push(`renumber: 'newNumber' must be a finite number.`); return { errors, warnings: [] }; }
    const current = chapterNumberOf(chapter, a.profile, a.structuralAliases);
    if (current === a.newNumber) errors.push(`renumber: chapter '${a.chapterId}' already has number ${a.newNumber}.`);
    const used = usedChapterNumbers(base, a.profile, a.structuralAliases, a.chapterId);
    if (used.has(a.newNumber)) errors.push(`renumber: chapter number ${a.newNumber} is already used by '${used.get(a.newNumber)}'. renumber targets a FREE number; moving into an occupied slot (insert-with-shift / swap) is a separate, explicit operation.`);
    // Structural-edit preflight on the chapter itself (safe paths + existing key).
    errors.push(...structuralEditErrors(chapter, a.chapterId, K_CHAPTER_NUMBER, a.structuralAliases));
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    let nodes = editStructural(base.nodes, a.chapterId, K_CHAPTER_NUMBER, a.newNumber, a.structuralAliases);
    // Cascade-rewrite every child lesson's chapter-membership number so the
    // Regime-B join key stays consistent with the renumbered chapter.
    for (const lesson of childLessons(base, a.chapterId, a.profile)) {
      nodes = editStructural(nodes, lesson.id, K_LESSON_CHAPTER, a.newNumber, a.structuralAliases);
    }
    return { nodes, edges: base.edges };
  },
};

// ── The recipe registry — the MIRROR get_capabilities declares (#14 decision f) ─
// One descriptor per recipe. get_capabilities renders THIS array (never a
// hand-authored copy), so what Claude discovers can't drift from what's built.
// `renumberBearing` marks a recipe that changes an EXISTING chapter's number;
// `regimeGated` marks one whose correctness depends on the Regime-B
// `chapitreNum` cascade (move/split/renumber rewrite it; add_* set it at birth).
export type RecipeParam = { name: string; required: boolean; note?: string };
export type RecipeDescriptor = {
  name: string;
  summary: string;
  params: RecipeParam[];
  renumberBearing: boolean;
  regimeGated: boolean;
};

export const RECIPES: readonly RecipeDescriptor[] = [
  {
    name: "add_lesson",
    summary: "Create a lesson and link it to an existing chapter (additive). Sets the lesson's chapter-membership number so it renders under that chapter.",
    params: [
      { name: "chapterId", required: true },
      { name: "text", required: true, note: "the lesson objective" },
      { name: "text_en", required: false },
      { name: "order", required: false, note: "within-chapter position; defaults to appending at the end" },
      { name: "isBilan", required: false, note: "mark this lesson as the end-of-chapter assessment" },
    ],
    renumberBearing: false,
    regimeGated: false,
  },
  {
    name: "add_chapter",
    summary: "Create a chapter (title + number at birth) with optional seed lessons, as one composite. The number must be FREE (append or fill a gap); a colliding number is rejected.",
    params: [
      { name: "number", required: true, note: "must be a free chapter number (append/gap-fill only)" },
      { name: "title", required: true },
      { name: "title_en", required: false },
      { name: "lessons", required: false, note: "array of { text, text_en?, isBilan? } seed lessons" },
    ],
    renumberBearing: false,
    regimeGated: false,
  },
  {
    name: "move_lesson",
    summary: "Rehome a lesson from its current chapter to another (unlink + relink) and rewrite its chapter-membership number. Numbers are preserved; appends to the target by default.",
    params: [
      { name: "lessonId", required: true },
      { name: "toChapterId", required: true },
      { name: "position", required: false, note: "within-target position; defaults to appending at the end" },
    ],
    renumberBearing: false,
    regimeGated: true,
  },
  {
    name: "split_chapter",
    summary: "Create a new chapter and move the tail lessons (from atLesson onward) into it, atomically. The new chapter is appended at the next free number by default (no shift of existing chapters).",
    params: [
      { name: "chapterId", required: true },
      { name: "atLessonId", required: true, note: "first lesson (inclusive) to move to the new chapter" },
      { name: "newTitle", required: false, note: "defaults to '<source title> (suite)'" },
      { name: "newTitle_en", required: false },
      { name: "newNumber", required: false, note: "must be a free number; omit to append at the end" },
    ],
    renumberBearing: false,
    regimeGated: true,
  },
  {
    name: "renumber",
    summary: "Change a chapter's number and cascade-rewrite every child lesson's chapter-membership number in one atomic composite, so nothing drifts. The target number must be FREE (no shift or swap).",
    params: [
      { name: "chapterId", required: true },
      { name: "newNumber", required: true, note: "must be a free chapter number" },
    ],
    renumberBearing: true,
    regimeGated: true,
  },
];
