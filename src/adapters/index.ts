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
import { buildCiMathsAdapter } from "./ci-maths.js";
import { buildCe1ReadingAdapter } from "./ce1-reading.js";

// Registry: (grade/subject) → adapter builder. Add a subject by registering
// its builder here. A subject with sources on disk but no entry here is
// rejected by set_context (unsupported), rather than silently mis-handled.
//
// Many-to-one is supported explicitly: two `${grade}/${subject}` keys may point
// at the same builder when their graphs share a shape. Different grades of the
// same subject stay independent by default — a `ce2/maths` graph with a
// different envelope would register its own adapter, not reuse ci/maths.
export type AdapterBuilder = (grade: string, subject: string) => SubjectAdapter;

const REGISTRY: Record<string, AdapterBuilder> = {
  "ci/maths": buildCiMathsAdapter,
  "ce1/reading": buildCe1ReadingAdapter,
};

export function resolveAdapter(grade: string, subject: string): SubjectAdapter | null {
  const build = REGISTRY[`${grade}/${subject}`];
  return build ? build(grade, subject) : null;
}

// Test-only surface: register a builder against an arbitrary (grade, subject)
// key. Used by the many-to-one resolution test to prove two keys can point at
// the same builder without shipping a synthetic subject in production.
export function __registerAdapterForTest(grade: string, subject: string, build: AdapterBuilder | null) {
  const key = `${grade}/${subject}`;
  if (build === null) delete REGISTRY[key];
  else REGISTRY[key] = build;
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
