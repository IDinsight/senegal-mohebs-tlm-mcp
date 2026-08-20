/*
 * Module: curriculum · parse-time prunes (registry)
 *
 * A `postParse` hook (see parse-graph.ts GraphParseDescriptor) trims the flat
 * unit list before the model is built. It used to be a hand-written closure on a
 * subject's adapter; now a subject NAMES a generic strategy from this registry
 * in its profile (adapters/profile.ts PruneSpec), keeping the pruning MECHANISM
 * as shared code while the SELECTION is data (docs/design-notes/authorable-catalog.md,
 * decision D7 — a named reachability option, deliberately not a full authorable
 * pruning language for one subject).
 *
 * There is one strategy today, `content-reachable-from-roots`, which is the CE1
 * reading Scope-B/C prune generalised to take its root kinds as a parameter. Its
 * intermediate kinds are the canonical Learning-Commons kinds a node reports as its
 * own identity — a day is a `Lesson`, a session an `Activity` (canonicalised reading
 * shape), spine standards `Standard`, components `LearningComponent`, content
 * `Activity`/`Material`. No reading vocabulary leaks in. A second strategy is a small
 * generic addition here, never a per-subject file.
 */
import type { CurriculumUnit } from "../types.js";

type RawNode = { id: string; labels?: string[]; properties?: Record<string, unknown> };
type RawRel = { id: string; type: string; start: string; end: string; properties?: Record<string, unknown> };
type PostParse = (units: CurriculumUnit[], raw: { nodes: RawNode[]; rels: RawRel[] }) => CurriculumUnit[] | void;

export type PruneStrategySpec = { strategy: "content-reachable-from-roots"; rootKinds: string[] };

// Keep only what a document actually needs: everything reachable from a root down
// the containment tree (to ANY depth — Course → week → day → session →
// Activity/Material), plus the standards those sessions teach and the standards'
// components. Everything else (orphans, unrelated spine) is dropped so the store
// stays lean. `rootKinds` selects the roots — e.g. `["Course"]` scopes a subject
// from its content root (scope-from-Course), `["Semaine"]` from week roots (the
// pre-Course reading shape); listing both is a safe transition (either matches).
function contentReachableFromRoots(rootKinds: Set<string>): PostParse {
  return (units) => {
    const byId = new Map(units.map((u) => [u.id, u]));
    // A standard's kind is its `statementType` (many values), so it is identified
    // by its structural class instead: a leaf StandardsFrameworkItem is
    // normalizedStatementType "Standard".
    const isLeafStandard = (u: CurriculumUnit | undefined) => u?.properties.normalizedStatementType === "Standard";
    const keep = new Set<string>();

    // Content closure: walk the containment tree (childIds) from each root to any
    // depth, keeping every node reached. Do NOT descend INTO a standard — a leaf
    // standard's childIds are reversed alignment/supports folds (its aligned
    // sessions + components), not containment, so following them would drag in the
    // whole spine. This one walk subsumes the old fixed Course-less 2-level descent
    // and the separate Activity/Material closure.
    const stack = units.filter((u) => rootKinds.has(u.kind)).map((u) => u.id);
    while (stack.length) {
      const id = stack.pop()!;
      const u = byId.get(id);
      if (!u || keep.has(id)) continue;
      keep.add(id);
      if (isLeafStandard(u)) continue;
      for (const cid of u.childIds) stack.push(cid);
    }

    // The standards a kept session teaches (session—hasEducationalAlignment→standard
    // folds so the standard's childIds ∋ the session), then those standards' components.
    // The aligned content leaf is a `Lesson` in the maths shape but an `Activity` in the
    // canonicalised reading shape (a day is the Lesson, a session the Activity) — accept
    // either so a standard is kept whenever a kept session aligns to it.
    const isAlignedContentLeaf = (u: CurriculumUnit | undefined) => u?.kind === "Lesson" || u?.kind === "Activity";
    for (const ex of units) {
      if (!isLeafStandard(ex)) continue;
      if (ex.childIds.some((cid) => isAlignedContentLeaf(byId.get(cid)) && keep.has(cid))) keep.add(ex.id);
    }
    for (const u of units) if (u.kind === "LearningComponent") { const p = byId.get(u.parentId ?? ""); if (p && keep.has(p.id)) keep.add(u.id); }

    return units.filter((u) => keep.has(u.id));
  };
}

// Resolve a profile's prune spec to the postParse closure the parser runs.
export function resolvePrune(spec: PruneStrategySpec): PostParse {
  switch (spec.strategy) {
    case "content-reachable-from-roots":
      return contentReachableFromRoots(new Set(spec.rootKinds));
  }
}
