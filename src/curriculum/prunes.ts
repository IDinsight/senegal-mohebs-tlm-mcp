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
 * own identity — day groupings are `Jour`, sessions `Lesson`, spine standards
 * `Standard`, components `LearningComponent`, content `Activity`/`Material`. No
 * reading vocabulary leaks in. A second strategy is a small generic addition here,
 * never a per-subject file.
 */
import type { CurriculumUnit } from "../types.js";

type RawNode = { id: string; labels?: string[]; properties?: Record<string, unknown> };
type RawRel = { id: string; type: string; start: string; end: string; properties?: Record<string, unknown> };
type PostParse = (units: CurriculumUnit[], raw: { nodes: RawNode[]; rels: RawRel[] }) => CurriculumUnit[] | void;

export type PruneStrategySpec = { strategy: "content-reachable-from-roots"; rootKinds: string[] };

// Keep only what a document actually needs: the root groupings, their content
// spine (day groupings → session lessons, or lessons directly under a root), the
// spine standards those sessions support, their components, and the content
// layer (Activity/Material) that hangs off any kept node. Everything else
// (orphans, unrelated spine) is dropped so the store stays lean. Ported verbatim
// from the CE1 reading adapter; `rootKinds` is the one thing that was hardcoded.
function contentReachableFromRoots(rootKinds: Set<string>): PostParse {
  return (units) => {
    const byId = new Map(units.map((u) => [u.id, u]));
    const keep = new Set<string>();
    for (const g of units) {
      if (!rootKinds.has(g.kind)) continue;
      keep.add(g.id);
      // A root holds day groupings (Jour, each holding session lessons) or, in the
      // pre-day-layer shape, session lessons directly.
      for (const cid of g.childIds) {
        const child = byId.get(cid);
        if (child?.kind === "Jour") { keep.add(cid); for (const lid of child.childIds) if (byId.get(lid)?.kind === "Lesson") keep.add(lid); }
        else if (child?.kind === "Lesson") keep.add(cid);
      }
    }
    // Standards a kept session supports (session→supports→standard folds so the
    // standard's childIds ∋ the session). A standard's kind is its `statementType`
    // (many values), so it is identified by its structural class instead: a leaf
    // StandardsFrameworkItem is normalizedStatementType "Standard".
    const isLeafStandard = (u: CurriculumUnit) => u.properties.normalizedStatementType === "Standard";
    for (const ex of units) {
      if (!isLeafStandard(ex)) continue;
      const supported = ex.childIds.some((cid) => byId.get(cid)?.kind === "Lesson" && keep.has(cid));
      if (supported) keep.add(ex.id);
    }
    for (const u of units) if (u.kind === "LearningComponent") { const p = byId.get(u.parentId ?? ""); if (p && keep.has(p.id)) keep.add(u.id); }
    // Content layer: the Activities/Materials the content tree hangs off any kept
    // node via containment. Closure over childIds restricted to Activity/Material
    // kinds, so a Material two levels down (under an Activity) is reached once its
    // Activity is kept, and nothing outside the content layer is pulled in.
    let changed = true;
    while (changed) {
      changed = false;
      for (const u of units) {
        if (!keep.has(u.id)) continue;
        for (const cid of u.childIds) {
          const c = byId.get(cid);
          if (c && (c.kind === "Activity" || c.kind === "Material") && !keep.has(cid)) { keep.add(cid); changed = true; }
        }
      }
    }
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
