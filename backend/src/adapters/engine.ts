/*
 * Module: adapters · shared engine
 *
 * The subject-agnostic piece every adapter used to copy: getting the parsed
 * model (`makeEnsure`). A subject profile supplies only what genuinely differs —
 * its parse descriptor and capabilities — and the generic factory (build.ts)
 * wires it together.
 */
import { sessionState } from "../context/index.js";
import { PRELOADED_MODEL_KEY } from "../curriculum/index.js";
import type { CurriculumModel } from "../types.js";

// The one way an adapter gets its CurriculumModel, memoized per adapter instance.
// It reads the model activate.ts pinned in the session bag when it hydrated the
// namespace from the store. A fresh adapter is built on every set_context, so
// each gets its own memo — nothing leaks across contexts.
export function makeEnsure(): () => CurriculumModel {
  let model: CurriculumModel | null = null;
  return () => {
    if (model) return model;
    const preloaded = sessionState().bag.get(PRELOADED_MODEL_KEY) as CurriculumModel | undefined;
    if (!preloaded) throw new Error("Curriculum was not preloaded from the store. Call activateContext() first.");
    return (model = preloaded);
  };
}
