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
import { noAccents } from "../utils/index.js";
import { makeEnsure, detectEnvelope } from "./engine.js";
import type { SubjectProfile, DeliverableProfile } from "./profile.js";
import type { SubjectAdapter, DeliverableSpec, CurriculumModel } from "../types.js";

// A profile's parse block → the GraphParseDescriptor the generic parser consumes.
// The only non-passthrough field is `prune`, resolved to the descriptor's
// postParse closure from the named-strategy registry.
function toDescriptor(parse: SubjectProfile["parse"]): GraphParseDescriptor {
  const { prune, ...rest } = parse;
  return { ...rest, ...(prune ? { postParse: resolvePrune(prune) } : {}) };
}

// Synthesize each deliverable's `classify(filename)` from its `match` spec. A
// "default" deliverable matches iff NO deliverable with a specific match does —
// reproducing the old `manual = !isLessons` complement without either deliverable
// naming the other. A `filenameContainsAny` matches accent/case-insensitively
// (noAccents lowercases), the same test the old `isLessons` used.
function classifiers(deliverables: DeliverableProfile[]): DeliverableSpec[] {
  const matchesSpecific = (d: DeliverableProfile, filename: string): boolean =>
    d.match !== "default" &&
    d.match.filenameContainsAny.some((term) => noAccents(filename).includes(noAccents(term)));

  const anySpecific = (filename: string) => deliverables.some((d) => matchesSpecific(d, filename));

  return deliverables.map((d) => ({
    key: d.key,
    label: d.label,
    scopeKind: d.scopeKind,
    dependsOn: d.dependsOn,
    promptFile: d.promptFile,
    ...(d.pathHint ? { pathHint: d.pathHint } : {}),
    classify: d.match === "default"
      ? (filename: string) => !anySpecific(filename)
      : (filename: string) => matchesSpecific(d, filename),
  }));
}

export function buildAdapterFromProfile(profile: SubjectProfile, grade: string, subject: string): SubjectAdapter {
  const descriptor = toDescriptor(profile.parse);
  const parse = (raw: unknown): CurriculumModel => parseGraph(raw, descriptor);
  const ensure = makeEnsure(parse);

  const adapter: SubjectAdapter = {
    grade, subject,
    id: profile.id,
    deliverables: classifiers(profile.deliverables),
    capabilities: profile.capabilities,
    detect: detectEnvelope,
    parse,
    model: ensure,
  };

  // Capability-gated generation helpers: present only when the subject rotates
  // example domains (the tool boundary in src/server/ci-maths.ts also checks the
  // flag, so this just avoids advertising a helper the subject won't use).
  if (profile.capabilities.exampleDomainRotation) {
    adapter.suggestFreshDomain = () => suggestFreshDomain();
    adapter.domainUsage = () => domainUsage();
  }

  return adapter;
}
