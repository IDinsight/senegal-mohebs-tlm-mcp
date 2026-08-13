/*
 * Module: curriculum · internal
 *
 * Generic, descriptor-driven parser: the shared skeleton that turns a
 * `{ nodes, relationships }` graph (the converged CE1-reading / CI-maths
 * envelope with the LC metadata scheme) into a CurriculumModel. All
 * subject-specific knowledge is injected via a GraphParseDescriptor, so ONE
 * traversal serves every subject on this envelope. Adapters own the descriptor
 * values (which role is a week/chapter/leaf, where the number lives, which edge
 * types matter, plus an optional post-parse hook); this module owns the walk.
 *
 * Layering: adapters (above) call this; it uses curriculum/model (below). It is
 * the single place that reads raw node/edge shape generically — the per-subject
 * raw quirks that don't fit the descriptor ride in `postParse`.
 */
import { buildModel, unit } from "./model.js";
import type { CurriculumModel, CurriculumUnit } from "../types.js";

type RawNode = { id: string; labels?: string[]; properties?: Record<string, any> };
type RawRel = { id: string; type: string; start: string; end: string; properties?: Record<string, any> };
type RawGraph = { nodes?: RawNode[]; relationships?: RawRel[] };

export type GraphParseDescriptor = {
  // A node's `metadata.role` → CurriculumUnit.kind (weeks/chapters/domaines/leaves).
  // Roles not listed here are ignored (scaffolding: paliers, sections, frameworks).
  roleToKind: Record<string, string>;
  // A node's canonical LC `statementType` → kind, tried AFTER role and BEFORE
  // label. This is the signal for LC-native exports (e.g. the NERDC/EIDU spine)
  // that carry no `metadata.role` sidecar and use a single StandardsFrameworkItem
  // label for every level — Grade/Theme/Sub-Theme/Topic/Performance Objective are
  // distinguished only here. Opt-in per descriptor: subjects that key on role
  // (senegal) simply omit it, so there is no interaction with their parse.
  statementTypeToKind?: Record<string, string>;
  // A node's first label → kind, used only when no mapped role/statementType
  // applies (components/tasks carry a label but no metadata.role).
  labelToKind?: Record<string, string>;
  // Where a unit's ordinal comes from: "order" = metadata.order (maths);
  // "position" = the canonical LC `position` prop (reading, post canonical-LC);
  // "description" = a bare-number description (legacy reading weeks). Omit when
  // the source carries no ordinal (e.g. the NERDC spine) — every unit's `order`
  // is then null and the adapter reads sequence from source/traversal order.
  numberFrom?: "order" | "position" | "description";
  // Edge types. Defaults match canonical LC. Each accepts one type or several:
  // canonical LC splits containment across `hasChild` (standards hierarchy) and
  // `hasPart` (content tree), and attachment across `supports` (component→SFI)
  // and `hasEducationalAlignment` (lesson/activity→SFI) — the parser treats every
  // listed type identically, so both halves fold into the same child links.
  containerEdge?: string | string[];   // parent→child hierarchy, default ["hasChild","hasPart"]
  supportEdge?: string | string[];     // child→parent attachment, default ["supports","hasEducationalAlignment"]
  progressionEdge?: string; // from→to progression, e.g. "buildsTowards" (SFI↔SFI); omit if none
  // Content prerequisite edge (canonical LC `hasDependency`, LessonGrouping/Lesson/
  // Activity). Read REVERSED vs progressionEdge — `dependent hasDependency prereq`
  // means the prereq builds toward the dependent — so both yield the same
  // buildsTowards/buildsFrom read model. Omit if the subject has none.
  dependencyEdge?: string;
  // Subject hook run on the flat unit list (childIds/parents already linked)
  // just before buildModel — e.g. flag the bilan, dedup twin weeks. May mutate
  // in place and/or return a replacement list.
  postParse?: (units: CurriculumUnit[], raw: { nodes: RawNode[]; rels: RawRel[] }) => CurriculumUnit[] | void;
};

const GROUPING = "Standard Grouping";
// Content grouping labels are groupings by virtue of their LABEL — a LessonGrouping/
// Course is a grouping without needing the SFI-only `normalizedStatementType` marker.
// A StandardsFrameworkItem is a grouping only when it says so (Standard Grouping vs
// a Standard leaf), so it's caught by the `normalizedStatementType` check, not here.
const GROUPING_LABELS = new Set(["Course", "LessonGrouping", "StandardsFramework"]);

export function parseGraph(raw: unknown, d: GraphParseDescriptor): CurriculumModel {
  const g = (raw ?? {}) as RawGraph;
  const nodes = g.nodes ?? [];
  const rels = g.relationships ?? [];
  const containerEdges = new Set([d.containerEdge ?? ["hasChild", "hasPart"]].flat());
  const supportEdges = new Set([d.supportEdge ?? ["supports", "hasEducationalAlignment"]].flat());

  const kindOf = (n: RawNode): string | null => {
    const role = n.properties?.metadata?.role;
    if (role != null && d.roleToKind[role] != null) return d.roleToKind[role];
    const stype = n.properties?.statementType;
    if (stype != null && d.statementTypeToKind?.[stype] != null) return d.statementTypeToKind[stype];
    const label = n.labels?.[0];
    if (label != null && d.labelToKind?.[label] != null) return d.labelToKind[label];
    return null;
  };
  const orderOf = (n: RawNode): number | null => {
    if (d.numberFrom == null) return null;
    if (d.numberFrom === "order") {
      const o = n.properties?.metadata?.order;
      return typeof o === "number" ? o : null;
    }
    if (d.numberFrom === "position") {
      const p = n.properties?.position;
      return typeof p === "number" ? p : null;
    }
    const desc = String(n.properties?.description ?? "");
    return /^\d+$/.test(desc) ? Number(desc) : null;
  };

  // 1. nodes → units. For a Standard Grouping, `description` is a title/name; for
  //    a Standard (or a component/task node), it is the statement text.
  const units: CurriculumUnit[] = [];
  for (const n of nodes) {
    const kind = kindOf(n);
    if (!kind) continue;
    const p = n.properties ?? {};
    const label = n.labels?.[0];
    const grouping = (label != null && GROUPING_LABELS.has(label)) || p.normalizedStatementType === GROUPING;
    units.push(unit({
      id: n.id,
      kind,
      code: (p.statementCode as string) ?? null,
      title: grouping ? ((p.description as string) ?? null) : null,
      text: grouping ? null : ((p.description as string) ?? null),
      order: orderOf(n),
      // Canonical LC marks an assessment on the node itself (educationalUse ===
      // "Assessment") — e.g. a maths end-of-chapter bilan lesson. Read it here so
      // no subject postParse hook has to; a subject that has no assessments simply
      // never sees the flag set.
      isAssessment: p.educationalUse === "Assessment",
      properties: p,
      labels: n.labels ?? [],
    }));
  }
  const byId = new Map(units.map((u) => [u.id, u]));

  // 2. hierarchy (containerEdge): start = parent, end = child. A node may be a
  //    child on more than one axis (a maths OS under both its week and its
  //    chapter) — childIds carries FULL membership; parentId is last-wins and is
  //    only used to derive roots, so the ambiguity is harmless.
  for (const r of rels) {
    if (!containerEdges.has(r.type)) continue;
    const parent = byId.get(r.start), child = byId.get(r.end);
    if (!parent || !child) continue;
    parent.childIds.push(child.id);
    child.parentId = parent.id;
  }

  // 3. attachment (supportEdge): start = child (component/task), end = parent
  //    (standard/component). Only links between two in-scope units survive, so a
  //    component supporting an out-of-spine framework standard drops out naturally.
  for (const r of rels) {
    if (!supportEdges.has(r.type)) continue;
    const child = byId.get(r.start), parent = byId.get(r.end);
    if (!child || !parent) continue;
    parent.childIds.push(child.id);
    child.parentId = parent.id;
  }

  // 4. progression (progressionEdge): start builds towards end. Both ends record
  //    the link so the inverse list (buildsFrom) is populated too.
  if (d.progressionEdge) {
    for (const r of rels) {
      if (r.type !== d.progressionEdge) continue;
      const from = byId.get(r.start), to = byId.get(r.end);
      if (!from || !to) continue;
      from.buildsTowards.push(to.id);
      to.buildsFrom.push(from.id);
    }
  }
  // 4b. content prerequisites (dependencyEdge) — REVERSED: `dependent hasDependency
  //     prereq`, so the prereq builds towards the dependent (same buildsTowards/
  //     buildsFrom read as a forward progression edge would give).
  if (d.dependencyEdge) {
    for (const r of rels) {
      if (r.type !== d.dependencyEdge) continue;
      const dependent = byId.get(r.start), prereq = byId.get(r.end);
      if (!dependent || !prereq) continue;
      prereq.buildsTowards.push(dependent.id);
      dependent.buildsFrom.push(prereq.id);
    }
  }

  const finalUnits = (d.postParse && d.postParse(units, { nodes, rels })) || units;
  const model = buildModel(finalUnits);
  // Echo the raw graph so the store can persist EVERY node + edge (spine and
  // non-spine) for a faithful, re-exportable copy — not just the parsed spine.
  model.rawGraph = {
    nodes: nodes.map((n) => ({ id: n.id, labels: n.labels, properties: n.properties })),
    relationships: rels.map((r) => ({ id: r.id, type: r.type, start: r.start, end: r.end, properties: r.properties })),
  };
  return model;
}
