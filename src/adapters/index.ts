/*
 * Module: adapters
 *
 * Registry that binds each `(grade, subject)` to its SubjectAdapter, plus the
 * active-adapter accessors the server tools use. Replaces the historical split
 * of profiles/ + curriculum/adapters/ — each subject now ships ONE adapter
 * module (this directory) exposing behavior for the whole read path.
 *
 * Resolution is many-to-one capable by construction: the registry is keyed on
 * `${grade}/${subject}` (grade × subject, not just subject — different grades
 * of the "same" subject may need different adapters when their graphs differ),
 * and multiple keys may point at the same builder when their graphs happen to
 * share a shape.
 *
 * Adapters are BEHAVIOR ONLY. There is no `schema` export, no LC property/edge
 * declarations, and no integrity rules — that is deliberate. Write-safety
 * rules for later phases live in the write tools, not on the adapter.
 */
import type { SubjectAdapter } from "../types.js";
import { ContextNotSetError, listAvailableContexts, sessionState } from "../context/index.js";
import { buildAdapterFromProfile } from "./build.js";
import { validateProfile, type SubjectProfile } from "./profile.js";
import { CI_MATHS_PROFILE } from "./profiles/ci-maths.js";
import { CE1_READING_PROFILE } from "./profiles/ce1-reading.js";
import { NIGERIA_MATHS_PROFILE } from "./profiles/nigeria-maths.js";

// Registry: (grade/subject) → subject PROFILE (data). A subject is added by
// authoring a profile literal and registering it here — no per-subject behavior
// module. Each profile is schema-validated at load, so a malformed profile fails
// loudly at startup rather than as a silent mis-parse in a later read. (Phase 2b
// moves these records into the store, edited through the curator loop; the
// validation then runs at authoring time. See docs/design-notes/authorable-catalog.md.)
//
// A subject with sources on disk but no entry here is rejected by set_context
// (unsupported), rather than silently mis-handled.
const PROFILES: Record<string, SubjectProfile> = Object.fromEntries(
  Object.entries({
    "ci/maths": CI_MATHS_PROFILE,
    "ce1/reading": CE1_READING_PROFILE,
    // Nigeria NERDC maths spans Primary 1–3 in one framework, so its grade
    // segment is the combined "primary-1-3" (see sources/nigeria/).
    "primary-1-3/maths": NIGERIA_MATHS_PROFILE,
  }).map(([key, profile]) => [key, validateProfile(profile, `profile for ${key}`)]),
);

// Many-to-one is supported by construction: two keys may share one profile when
// their graphs have the same shape, and the builder still stamps each with its
// own (grade, subject) identity.
export function resolveAdapter(grade: string, subject: string): SubjectAdapter | null {
  const profile = PROFILES[`${grade}/${subject}`];
  return profile ? buildAdapterFromProfile(profile, grade, subject) : null;
}

// Test-only surface: register a profile against an arbitrary (grade, subject)
// key. Used by the many-to-one resolution test to prove two keys can share one
// profile without shipping a synthetic subject in production.
export function __registerProfileForTest(grade: string, subject: string, profile: SubjectProfile | null) {
  const key = `${grade}/${subject}`;
  if (profile === null) delete PROFILES[key];
  else PROFILES[key] = profile;
}

// The adapter for the active context. Set by activate.ts on set_context and
// replaced (not mutated) on every switch, so caches never leak across contexts.
// Stored in the session bag: per-session in HTTP mode, process-wide in stdio.
// (activate.ts sets the context first — which clears the bag — then installs
// the new adapter, so the ordering keeps adapter and context in lockstep.)
const ADAPTER_KEY = "adapters.active";

export function setActiveAdapter(a: SubjectAdapter | null) {
  const { bag } = sessionState();
  if (a === null) bag.delete(ADAPTER_KEY);
  else bag.set(ADAPTER_KEY, a);
}

export function getActiveAdapter(): SubjectAdapter {
  // Throw the same error the storage/source helpers do, so curriculum tools that
  // only touch the adapter still surface the friendly "choose a context" prompt.
  const a = sessionState().bag.get(ADAPTER_KEY) as SubjectAdapter | undefined;
  if (!a) throw new ContextNotSetError(listAvailableContexts());
  return a;
}
