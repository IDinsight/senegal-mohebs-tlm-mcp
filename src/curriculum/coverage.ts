/*
 * Module: curriculum · internal
 *
 * Subject-NEUTRAL coverage helpers (#13). These compute structural-completeness
 * WARNINGS that any adapter can reuse by naming its own kinds — they carry no
 * subject vocabulary of their own. Subject-SPECIFIC rules (a CI maths chapter's
 * bilan, or its chapter-parent-scoped multi-parent rule) live in the adapter, not here.
 *
 * Why these two shapes are generic: they're properties of a `hasChild` tree,
 * which every subject's graph is, regardless of what the levels are called.
 *   • emptyContainerWarnings — a node that is expected to have children but
 *     has none. "Expected to" is the caller's call (it passes the kinds).
 *   • multiParentWarnings — a node with more than one `hasChild` parent. In a
 *     tree every node has at most one parent; two is almost always a mistake.
 *
 * All of these are WARNINGS. They never block — a curator may legitimately be
 * mid-edit (a freshly created chapter with no lessons yet is valid-but-suspect,
 * not corrupt). Referential CORRUPTION (a dangling edge) is caught earlier and
 * separately, as an ERROR, by validateStructural.
 *
 * Operates directly on the raw {nodes, edges} view rather than the deserialized
 * CurriculumModel, because multi-parent detection needs every `hasChild` edge
 * (the model collapses a node's parent to a single value and would hide a
 * second parent).
 */

import type { GraphView } from "../types.js";

// Canonical LC splits containment across `hasChild` (standards hierarchy) and
// `hasPart` (content tree) — a container "has children" via either.
const CONTAINMENT = new Set(["hasChild", "hasPart"]);

// Nodes of one of `containerKinds` that have zero outgoing containment edges.
// `label` names the kind in the message (e.g. "chapter", "week").
export function emptyContainerWarnings(graph: GraphView, containerKinds: Iterable<string>): string[] {
  const kinds = new Set(containerKinds);
  const hasAChild = new Set(
    graph.edges.filter((e) => CONTAINMENT.has(e.type)).map((e) => e.from),
  );
  const warnings: string[] = [];
  for (const n of graph.nodes) {
    if (!kinds.has(n.type)) continue;
    if (!hasAChild.has(n.id)) {
      warnings.push(
        `Coverage: ${n.type} '${labelFor(n)}' has no child ${childWord(n.type)} yet — ` +
        `it will render empty. Create and link its children before publishing, or this is an incomplete ${n.type}.`,
      );
    }
  }
  return warnings;
}

// Nodes with more than one incoming hasChild edge — i.e. more than one parent.
// Optionally restrict to `childKinds` (e.g. only warn for lessons); omit to
// check every node.
export function multiParentWarnings(graph: GraphView, childKinds?: Iterable<string>): string[] {
  const restrict = childKinds ? new Set(childKinds) : null;
  const parentsByChild = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!CONTAINMENT.has(e.type)) continue;
    (parentsByChild.get(e.to) ?? parentsByChild.set(e.to, []).get(e.to)!).push(e.from);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const warnings: string[] = [];
  for (const [childId, parents] of parentsByChild) {
    if (parents.length <= 1) continue;
    const child = byId.get(childId);
    if (restrict && (!child || !restrict.has(child.type))) continue;
    warnings.push(
      `Coverage: ${child?.type ?? "node"} '${child ? labelFor(child) : childId}' has ${parents.length} parents ` +
      `(${parents.join(", ")}) — a unit is expected to belong to exactly one parent. Unlink the extra parent(s).`,
    );
  }
  return warnings;
}

// A friendly label for a node — prefer a human title/text over the raw id, but
// fall back to the id so a message is never blank. Kept local (coverage-only).
function labelFor(n: { id: string; properties: Record<string, unknown> }): string {
  const p = n.properties;
  const title = typeof p.title === "string" && p.title ? p.title
    : typeof p.text === "string" && p.text ? p.text
    : null;
  return title ? `${title} (${n.id})` : n.id;
}

// A rough plural for the "has no child X" message, keyed on the canonical kind.
// Not i18n — an operator hint; anything unlisted falls back to "children".
function childWord(kind: string): string {
  switch (kind) {
    case "Chapitre": return "lessons";
    case "Semaine": return "days";
    case "Jour": return "sessions";
    case "Lesson": return "components";
    case "LearningComponent": return "tasks";
    default: return "children";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Two more generic rules + a dispatcher, so a subject's whole coverage policy is
// a DATA list of named rules (see adapters/profile.ts CoverageRuleSpec) rather
// than a hand-written closure. Like the two shapes above, these carry no subject
// vocabulary — the parent/child KINDS and the assessment NOUN are parameters.
// ─────────────────────────────────────────────────────────────────────────────

// Container→child links along ONE containment edge type, filtered to a
// parent/child kind pair. Shared by the two rules below; both care only about a
// specific axis (e.g. maths chapter→lesson via `hasPart`, not the week→lesson
// schedule axis), so the containment edge type is a parameter, not the union.
function childrenByParent(
  graph: GraphView,
  parentKind: string,
  childKind: string,
  containment: string,
): Map<string, GraphView["nodes"]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphView["nodes"]>();
  for (const e of graph.edges) {
    if (e.type !== containment) continue;
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || from.type !== parentKind || !to || to.type !== childKind) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(to);
  }
  return out;
}

// Exactly one assessment child per non-empty parent. Generalises the CI maths
// "one bilan per chapter" rule: a parent of `parentKind` holding ≥1 `childKind`
// child (via `containment`) should have exactly one child flagged
// `isAssessment`. `noun` is the subject's word for that child ("bilan"); it
// defaults to "assessment". An empty parent is skipped — that is the
// empty-container rule's job, not this one's.
export function assessmentChildWarnings(
  graph: GraphView,
  opts: { parentKind: string; childKind: string; containment?: string; noun?: string },
): string[] {
  const containment = opts.containment ?? "hasPart";
  const noun = opts.noun ?? "assessment";
  const children = childrenByParent(graph, opts.parentKind, opts.childKind, containment);
  const warnings: string[] = [];
  for (const parent of graph.nodes) {
    if (parent.type !== opts.parentKind) continue;
    const kids = children.get(parent.id) ?? [];
    if (kids.length === 0) continue; // covered by empty-container
    const assessments = kids.filter((k) => k.properties.isAssessment === true).length;
    const label = labelFor(parent);
    if (assessments === 0) {
      warnings.push(
        `Coverage: ${opts.parentKind} '${label}' has ${kids.length} ${opts.childKind}(s) but no ${noun} ` +
        `(end-of-${opts.parentKind} assessment). Mark one ${opts.childKind} as the ${noun} before publishing.`,
      );
    } else if (assessments > 1) {
      warnings.push(
        `Coverage: ${opts.parentKind} '${label}' has ${assessments} ${noun} ${opts.childKind}s — exactly one is expected.`,
      );
    }
  }
  return warnings;
}

// At most one parent along ONE content axis. This is the axis-scoped counterpart
// of multiParentWarnings: a CI maths lesson legitimately has two parents (its
// chapter on the content axis, its week on the schedule axis), so the blunt
// multi-parent rule can't be used — here we count only parents of `parentKind`
// reached via `containment` (chapter parents via `hasPart`) and warn on >1.
export function singleContentParentWarnings(
  graph: GraphView,
  opts: { childKind: string; parentKind: string; containment?: string },
): string[] {
  const containment = opts.containment ?? "hasPart";
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parentCount = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type !== containment) continue;
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || from.type !== opts.parentKind || !to || to.type !== opts.childKind) continue;
    parentCount.set(e.to, (parentCount.get(e.to) ?? 0) + 1);
  }
  const warnings: string[] = [];
  for (const [childId, count] of parentCount) {
    if (count <= 1) continue;
    const child = byId.get(childId)!;
    warnings.push(
      `Coverage: ${opts.childKind} '${labelFor(child)}' has ${count} ${opts.parentKind} parents — ` +
      `a ${opts.childKind} belongs to exactly one ${opts.parentKind} (other axes are separate). Detach it from all but one.`,
    );
  }
  return warnings;
}

// A rule spec (structurally the CoverageRuleSpec discriminated union authored in
// adapters/profile.ts) — restated here as a leaf-friendly shape so curriculum/
// (services) doesn't import up into adapters/. The dispatcher below turns a
// subject's list of these into the flat warning list the mutation framework and
// diff_draft consume.
export type CoverageRuleSpec =
  | { rule: "empty-container"; kinds: string[] }
  | { rule: "multi-parent"; childKinds?: string[] }
  | { rule: "exactly-one-assessment-child"; parentKind: string; childKind: string; containment?: string; noun?: string }
  | { rule: "single-content-parent"; childKind: string; parentKind: string; containment?: string };

export function runCoverageRules(graph: GraphView, rules: CoverageRuleSpec[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    switch (r.rule) {
      case "empty-container": out.push(...emptyContainerWarnings(graph, r.kinds)); break;
      case "multi-parent": out.push(...multiParentWarnings(graph, r.childKinds)); break;
      case "exactly-one-assessment-child": out.push(...assessmentChildWarnings(graph, r)); break;
      case "single-content-parent": out.push(...singleContentParentWarnings(graph, r)); break;
    }
  }
  return out;
}
