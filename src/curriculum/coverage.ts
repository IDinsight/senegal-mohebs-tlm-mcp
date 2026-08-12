// ── Module: curriculum · internal ────────────────────────────────────────────
// Subject-NEUTRAL coverage helpers (#13). These compute structural-completeness
// WARNINGS that any adapter can reuse by naming its own kinds — they carry no
// subject vocabulary of their own. Subject-SPECIFIC rules (a CI maths chapter's
// bilan, or its chapter-parent-scoped multi-parent rule) live in the adapter, not here.
//
// Why these two shapes are generic: they're properties of a `hasChild` tree,
// which every subject's graph is, regardless of what the levels are called.
//   • emptyContainerWarnings — a node that is expected to have children but
//     has none. "Expected to" is the caller's call (it passes the kinds).
//   • multiParentWarnings — a node with more than one `hasChild` parent. In a
//     tree every node has at most one parent; two is almost always a mistake.
//
// All of these are WARNINGS. They never block — a curator may legitimately be
// mid-edit (a freshly created chapter with no lessons yet is valid-but-suspect,
// not corrupt). Referential CORRUPTION (a dangling edge) is caught earlier and
// separately, as an ERROR, by validateStructural.
//
// Operates directly on the raw {nodes, edges} view rather than the deserialized
// CurriculumModel, because multi-parent detection needs every `hasChild` edge
// (the model collapses a node's parent to a single value and would hide a
// second parent).

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

// A rough plural for the "has no child X" message. Not i18n — an operator hint.
function childWord(kind: string): string {
  switch (kind) {
    case "chapter": return "lessons";
    case "week": return "days";
    case "day": return "sessions";
    case "lesson": return "components";
    case "component": return "tasks";
    default: return "children";
  }
}
