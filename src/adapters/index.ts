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
import { validateProfile, validateProfileRecord, type SubjectProfile } from "./profile.js";

// Re-export the profile schema surface so cross-module callers (e.g. the
// edit_profile server tool) reach it through this barrel, per the layering rule.
export { validateProfile, validateProfileRecord, MAX_GUIDE_CHARS } from "./profile.js";
export type { SubjectProfile, ProfileRecord } from "./profile.js";
import { CI_MATHS_PROFILE, CI_MATHS_GUIDE } from "./profiles/ci-maths.js";
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

// The in-repo profile CORE for a (grade, subject), already validated at load.
// This is the seed's SOURCE for the machine core and the fallback the firestore
// path uses for a namespace seeded before the config layer existed (no cell yet).
export function getRegisteredProfile(grade: string, subject: string): SubjectProfile | null {
  return PROFILES[`${grade}/${subject}`] ?? null;
}

// The in-repo GRAPH GUIDE (authored markdown, phase 2c) for a (grade, subject),
// or undefined when the subject ships without one yet. The seed writes it into
// the config cell alongside the core; the guide is for the LLM, never for reads.
const GUIDES: Record<string, string> = {
  "ci/maths": CI_MATHS_GUIDE,
};
export function getRegisteredGuide(grade: string, subject: string): string | undefined {
  return GUIDES[`${grade}/${subject}`];
}

// Build an adapter from a profile record READ FROM THE STORE (phase 2b/2c)
// rather than the in-repo literal. The stored payload is untrusted JSON and may
// be the new { core, guide } record OR a legacy flat profile (pre-split seed);
// validateProfileRecord normalizes both and applies the SAME Zod guard the
// load-time registry uses to the CORE. The adapter is built from the core only —
// the guide never touches the read path. A malformed core throws a readable
// error here (surfaced by activate.ts as a refuse-to-load).
export function buildAdapterFromStoredProfile(grade: string, subject: string, raw: unknown): SubjectAdapter {
  const { core } = validateProfileRecord(raw, `stored profile for ${grade}/${subject}`);
  return buildAdapterFromProfile(core, grade, subject);
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
