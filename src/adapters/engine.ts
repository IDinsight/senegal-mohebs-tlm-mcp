/*
 * Module: adapters · shared engine
 *
 * The subject-agnostic pieces every adapter used to copy: loading the parsed
 * model, the generic `detect` envelope guard, aggregating recurring characters
 * across past documents, indexing a lesson to the standard it aligns to, and
 * building the usual text/text_en wording aliases. A per-subject adapter now
 * supplies only what genuinely differs — its parse descriptor, its read
 * projection shape, and its deliverables/config.
 */
import { readFileSync } from "node:fs";
import { CONFIG, kgSource } from "../config.js";
import { sourcePath, sessionState } from "../context/index.js";
import { PRELOADED_MODEL_KEY } from "../curriculum/index.js";
import type { CharacterRef, CurriculumModel, CurriculumUnit, HistoryEntry, WordingAliases } from "../types.js";

// The one way an adapter gets its CurriculumModel, memoized per adapter instance.
// firestore mode reads the model activate.ts pinned in the session bag; bundle
// mode (dev) parses the on-disk knowledge_graph.json. A fresh adapter is built on
// every set_context, so each gets its own memo — nothing leaks across contexts.
export function makeEnsure(parse: (raw: unknown) => CurriculumModel): () => CurriculumModel {
  let model: CurriculumModel | null = null;
  return () => {
    if (model) return model;
    if (kgSource() === "firestore") {
      const preloaded = sessionState().bag.get(PRELOADED_MODEL_KEY) as CurriculumModel | undefined;
      if (!preloaded) throw new Error("KG_SOURCE=firestore but curriculum was not preloaded from the store. Call activateContext() first.");
      return (model = preloaded);
    }
    return (model = parse(JSON.parse(readFileSync(sourcePath(CONFIG.kgFile), "utf8"))));
  };
}

// The bundle-mode schema guard set_context runs before activating (firestore mode
// skips it — the store is already parsed). It only checks the graph is the
// converged `{ nodes, relationships }` envelope; which subject it is was already
// decided by the grade/subject key, so no subject-specific signal is needed here.
export function detectEnvelope(raw: unknown): boolean {
  const g = raw as { nodes?: unknown[]; relationships?: unknown[] } | undefined;
  return Array.isArray(g?.nodes) && Array.isArray(g?.relationships);
}

// A character established in earlier documents, ready to reuse. `firstUnit` is the
// earliest scope (chapter/week) it appeared in — used only to order the list.
export type EstablishedCharacter = { name: string; type?: string; role?: string; description?: string; firstUnit: number };

// Roll every past document's `characters` up by name: earliest unit wins, and
// type/role/description fill in from whichever entry first has them. Sorted by
// first appearance, then name. Identical need for maths and reading.
export function aggregateCharacters(entries: HistoryEntry[]): EstablishedCharacter[] {
  const byName = new Map<string, EstablishedCharacter>();
  for (const e of entries) {
    for (const raw of e.content.characters ?? []) {
      const c: CharacterRef = typeof raw === "string" ? { name: raw } : raw;
      if (!c?.name) continue;
      const existing = byName.get(c.name);
      if (!existing) byName.set(c.name, { name: c.name, type: c.type, role: c.role, description: c.description, firstUnit: e.unit });
      else {
        existing.firstUnit = Math.min(existing.firstUnit, e.unit);
        existing.type ??= c.type; existing.role ??= c.role; existing.description ??= c.description;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.firstUnit - b.firstUnit || a.name.localeCompare(b.name));
}

// Index each content Lesson to the standard (expectation) it aligns to. The
// parser records that alignment as expectation.childIds ∋ the lesson, so one scan
// of the expectations builds the reverse map. Both subjects read it the same way.
export function alignedStandardOf(m: CurriculumModel): Map<string, CurriculumUnit> {
  const map = new Map<string, CurriculumUnit>();
  for (const ex of m.unitsOfKind("expectation"))
    for (const child of m.childrenOf(ex.id)) if (child.kind === "lesson") map.set(child.id, ex);
  return map;
}

// Build the standard text/text_en wording aliases for the given kinds: a node's
// normalized field and its `raw` source mirror hold the same wording, so one
// upsert_property call keeps both in sync. English wording lives under
// raw.metadata.en.*. Subjects with a kind that needs extra mirror paths (e.g. a
// maths expectation's raw.osTexte) declare that entry by hand instead.
export function textWording(...kinds: string[]): WordingAliases {
  const out: WordingAliases = {};
  for (const k of kinds) out[k] = { text: ["text", "raw.description"], text_en: ["raw.metadata.en.description"] };
  return out;
}
