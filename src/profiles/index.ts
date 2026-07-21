import type { SubjectProfile } from "../types.js";
import { buildMathsProfile } from "./maths.js";
import { ContextNotSetError, listAvailableContexts } from "../context-state.js";

// Registry: (grade/subject) → profile builder. Add a subject by registering its
// builder here. A subject with sources on disk but no entry here is rejected by
// set_context (unsupported), rather than silently mis-handled.
type ProfileBuilder = (grade: string, subject: string) => SubjectProfile;
const REGISTRY: Record<string, ProfileBuilder> = {
  "ci/maths": buildMathsProfile,
};

export function resolveProfile(grade: string, subject: string): SubjectProfile | null {
  const build = REGISTRY[`${grade}/${subject}`];
  return build ? build(grade, subject) : null;
}

// The profile for the active context. Set by context-state on set_context and
// replaced (not mutated) on every switch, so caches never leak across contexts.
let activeProfile: SubjectProfile | null = null;
export function setActiveProfile(p: SubjectProfile | null) { activeProfile = p; }
export function getActiveProfile(): SubjectProfile {
  // Throw the same error the storage/source helpers do, so curriculum tools that
  // only touch the profile still surface the friendly "choose a context" prompt.
  if (!activeProfile) throw new ContextNotSetError(listAvailableContexts());
  return activeProfile;
}
