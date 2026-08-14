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
import type { CurriculumModel, WordingAliases } from "../types.js";

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
