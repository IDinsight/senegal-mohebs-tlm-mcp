// ── Module: curriculum · internal ────────────────────────────────────────────
// The subject-neutral shape every graph is parsed into: a flat set of units
// linked by parentId/childIds. Adapters (curriculum/adapters/*) do the raw-graph
// parsing and hand the units here; buildModel() adds the lookup indexes the
// presenters and generation code read. See docs/multi-subject-architecture.md §5.1.
import type { CurriculumUnit, CurriculumModel } from "../types.js";

// Assemble a CurriculumModel from a flat list of units. Callers set each unit's
// parentId/childIds/buildsTowards themselves; this only adds the lookup indexes
// and derives `roots` (units with no parent, in insertion order).
export function buildModel(units: CurriculumUnit[]): CurriculumModel {
  const byId = new Map<string, CurriculumUnit>();
  for (const u of units) byId.set(u.id, u);

  const byKind = new Map<string, CurriculumUnit[]>();
  for (const u of units) (byKind.get(u.kind) ?? byKind.set(u.kind, []).get(u.kind)!).push(u);

  const roots = units.filter((u) => u.parentId == null || !byId.has(u.parentId)).map((u) => u.id);

  return {
    roots,
    byId,
    unitsOfKind: (kind) => byKind.get(kind) ?? [],
    childrenOf: (id) => (byId.get(id)?.childIds ?? []).map((cid) => byId.get(cid)).filter((u): u is CurriculumUnit => !!u),
  };
}

// Convenience for adapters: make a unit with sensible defaults.
export function unit(u: Partial<CurriculumUnit> & Pick<CurriculumUnit, "id" | "kind">): CurriculumUnit {
  return {
    code: null, title: null, text: null, order: null, parentId: null,
    childIds: [], buildsTowards: [], buildsFrom: [], isAssessment: false, properties: {},
    ...u,
  };
}
