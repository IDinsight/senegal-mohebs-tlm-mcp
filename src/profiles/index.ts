import type { SubjectProfile } from "../types.js";
import { buildMathsProfile } from "./maths.js";
import { buildReadingProfile } from "./reading.js";
import { ContextNotSetError, listAvailableContexts, sessionState } from "../context/index.js";

// Registry: (grade/subject) → profile builder. Add a subject by registering its
// builder here. A subject with sources on disk but no entry here is rejected by
// set_context (unsupported), rather than silently mis-handled.
type ProfileBuilder = (grade: string, subject: string) => SubjectProfile;
const REGISTRY: Record<string, ProfileBuilder> = {
  "ci/maths": buildMathsProfile,
  "ce1/reading": buildReadingProfile,
};

export function resolveProfile(grade: string, subject: string): SubjectProfile | null {
  const build = REGISTRY[`${grade}/${subject}`];
  return build ? build(grade, subject) : null;
}

// The profile for the active context. Set by activate.ts on set_context and
// replaced (not mutated) on every switch, so caches never leak across contexts.
// Stored in the session bag: per-session in HTTP mode, process-wide in stdio.
// (activate.ts sets the context first — which clears the bag — then installs
// the new profile, so the ordering keeps profile and context in lockstep.)
const PROFILE_KEY = "profiles.active";
export function setActiveProfile(p: SubjectProfile | null) {
  const { bag } = sessionState();
  if (p === null) bag.delete(PROFILE_KEY);
  else bag.set(PROFILE_KEY, p);
}
export function getActiveProfile(): SubjectProfile {
  // Throw the same error the storage/source helpers do, so curriculum tools that
  // only touch the profile still surface the friendly "choose a context" prompt.
  const p = sessionState().bag.get(PROFILE_KEY) as SubjectProfile | undefined;
  if (!p) throw new ContextNotSetError(listAvailableContexts());
  return p;
}
