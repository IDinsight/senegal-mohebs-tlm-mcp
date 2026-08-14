/*
 * Module: adapters · shared engine
 *
 * The subject-agnostic pieces every adapter used to copy: loading the parsed
 * model (`makeEnsure`) and the generic `detect` envelope guard. A subject profile
 * supplies only what genuinely differs — its parse descriptor and its
 * deliverables/config — and the generic factory (build.ts) wires it together.
 */
import { readFileSync } from "node:fs";
import { CONFIG, kgSource } from "../config.js";
import { sourcePath, sessionState } from "../context/index.js";
import { PRELOADED_MODEL_KEY } from "../curriculum/index.js";
import type { CurriculumModel } from "../types.js";

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

