/*
 * Module: adapters · generic builder
 *
 * ONE builder that turns a declarative `SubjectProfile` (profile.ts) into a
 * `SubjectAdapter` — the runtime object the rest of the server dispatches to.
 * This is what lets a subject be DATA instead of a hand-written behavior module:
 * the three per-subject `.ts` adapters collapse into three profile literals plus
 * this single generic factory (docs/design-notes/authorable-catalog.md, phase 2).
 *
 * The adapter's runtime shape is unchanged — consumers still see `classify`
 * functions, a `coverageWarnings` function, a `parse`, etc. Only their SOURCE
 * changes: each is synthesized here from the profile's data, via the shared
 * generic mechanisms (parseGraph, the coverage-rule dispatcher, the prune
 * registry). So nothing downstream of the adapter changes.
 */
import { suggestFreshDomain, domainUsage } from "../generation/index.js";
import { parseGraph, resolvePrune, type GraphParseDescriptor } from "../curriculum/index.js";
import { makeEnsure } from "./engine.js";
import type { SubjectProfile } from "./profile.js";
import type { SubjectAdapter, CurriculumModel } from "../types.js";

// A profile's parse block → the GraphParseDescriptor the generic parser consumes.
// The only non-passthrough field is `prune`, resolved to the descriptor's
// postParse closure from the named-strategy registry.
function toDescriptor(parse: SubjectProfile["parse"]): GraphParseDescriptor {
  const { prune, ...rest } = parse;
  return { ...rest, ...(prune ? { postParse: resolvePrune(prune) } : {}) };
}

export function buildAdapterFromProfile(profile: SubjectProfile, grade: string, subject: string): SubjectAdapter {
  const descriptor = toDescriptor(profile.parse);
  const parse = (raw: unknown): CurriculumModel => parseGraph(raw, descriptor);

  const adapter: SubjectAdapter = {
    grade, subject,
    id: profile.id,
    capabilities: profile.capabilities,
    parse,
    model: makeEnsure(),
  };

  // Capability-gated generation helpers: present only when the subject rotates
  // example domains (the tool boundary in src/server/ci-maths.ts also checks the
  // flag, so this just avoids advertising a helper the subject won't use).
  if (profile.capabilities.exampleDomainRotation) {
    // A document's chapter number is its scope node's ordinal, read from this
    // adapter's model at call time (the history no longer stores it).
    const ordinalOf = (nodeId: string) => adapter.model().byId.get(nodeId)?.order ?? null;
    adapter.suggestFreshDomain = () => suggestFreshDomain(ordinalOf);
    adapter.domainUsage = () => domainUsage(ordinalOf);
  }

  return adapter;
}
