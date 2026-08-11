// ── Module: curriculum · internal ────────────────────────────────────────────
// Generic, descriptor-driven parser: the shared skeleton that turns a
// `{ nodes, relationships }` graph (the converged CE1-reading / CI-maths
// envelope with the LC metadata scheme) into a CurriculumModel. All
// subject-specific knowledge is injected via a GraphParseDescriptor, so ONE
// traversal serves every subject on this envelope. Adapters own the descriptor
// values (which role is a week/chapter/leaf, where the number lives, which edge
// types matter, plus an optional post-parse hook); this module owns the walk.
//
// Layering: adapters (above) call this; it uses curriculum/model (below). It is
// the single place that reads raw node/edge shape generically — the per-subject
// raw quirks that don't fit the descriptor ride in `postParse`.
import { buildModel, unit } from "./model.js";
import type { CurriculumModel, CurriculumUnit } from "../types.js";

type RawNode = { id: string; labels?: string[]; properties?: Record<string, any> };
type RawRel = { id: string; type: string; start: string; end: string; properties?: Record<string, any> };
type RawGraph = { nodes?: RawNode[]; relationships?: RawRel[] };

export type GraphParseDescriptor = {
  // A node's `metadata.role` → CurriculumUnit.kind (weeks/chapters/domaines/leaves).
  // Roles not listed here are ignored (scaffolding: paliers, sections, frameworks).
  roleToKind: Record<string, string>;
  // A node's first label → kind, used only when no mapped role applies
  // (components/tasks carry a label but no metadata.role).
  labelToKind?: Record<string, string>;
  // Where a unit's ordinal comes from: "order" = metadata.order (maths);
  // "description" = a bare-number description (reading weeks).
  numberFrom: "order" | "description";
  // Edge types. Defaults match the converged envelope.
  containerEdge?: string;   // parent→child hierarchy, default "hasChild"
  supportEdge?: string;     // child→parent attachment (component→standard, task→component), default "supports"
  progressionEdge?: string; // from→to progression, e.g. "buildsTowards"; omit if the subject has none
  // Subject hook run on the flat unit list (childIds/parents already linked)
  // just before buildModel — e.g. flag the bilan, dedup twin weeks. May mutate
  // in place and/or return a replacement list.
  postParse?: (units: CurriculumUnit[], raw: { nodes: RawNode[]; rels: RawRel[] }) => CurriculumUnit[] | void;
};

const GROUPING = "Standard Grouping";

export function parseGraph(raw: unknown, d: GraphParseDescriptor): CurriculumModel {
  const g = (raw ?? {}) as RawGraph;
  const nodes = g.nodes ?? [];
  const rels = g.relationships ?? [];
  const containerEdge = d.containerEdge ?? "hasChild";
  const supportEdge = d.supportEdge ?? "supports";

  const kindOf = (n: RawNode): string | null => {
    const role = n.properties?.metadata?.role;
    if (role != null && d.roleToKind[role] != null) return d.roleToKind[role];
    const label = n.labels?.[0];
    if (label != null && d.labelToKind?.[label] != null) return d.labelToKind[label];
    return null;
  };
  const orderOf = (n: RawNode): number | null => {
    if (d.numberFrom === "order") {
      const o = n.properties?.metadata?.order;
      return typeof o === "number" ? o : null;
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
    const grouping = p.normalized_statement_type === GROUPING;
    units.push(unit({
      id: n.id,
      kind,
      code: (p.statement_code as string) ?? null,
      title: grouping ? ((p.description as string) ?? null) : null,
      text: grouping ? null : ((p.description as string) ?? null),
      order: orderOf(n),
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
    if (r.type !== containerEdge) continue;
    const parent = byId.get(r.start), child = byId.get(r.end);
    if (!parent || !child) continue;
    parent.childIds.push(child.id);
    child.parentId = parent.id;
  }

  // 3. attachment (supportEdge): start = child (component/task), end = parent
  //    (standard/component). Only links between two in-scope units survive, so a
  //    component supporting an out-of-spine framework standard drops out naturally.
  for (const r of rels) {
    if (r.type !== supportEdge) continue;
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
