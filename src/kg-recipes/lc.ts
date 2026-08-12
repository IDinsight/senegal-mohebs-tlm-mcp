/*
 * kg-recipes · canonical Learning-Commons vocabulary
 *
 * Canonical LC constants (containment/alignment edges, the ordinal field) plus
 * `deriveTemplate`. To add, say, a Lesson, we don't hardcode what a Lesson looks
 * like — we copy an existing Lesson's shape (its labels, normalized type, role,
 * and which raw field holds its order) off the graph. First of a kind, with no
 * example to copy (reading has no Activity yet)? Fall back to canonical defaults.
 *
 * Full rationale: docs/design-notes/graph-native-authoring.md.
 */

import type { MutationGraph, MutationNode } from "../kg-store/index.js";

// LC content-tree labels — nested by `hasPart` (Course ▸ LessonGrouping ▸ Lesson
// ▸ Activity ▸ Material). The standards tree nests by `hasChild`.
const CONTENT_LABELS = new Set(["Course", "LessonGrouping", "Lesson", "Activity", "Material"]);
const STANDARDS_LABELS = new Set(["StandardsFramework", "StandardsFrameworkItem"]);
// Labels whose display name lives in the normalized `title` (a "Standard
// Grouping"), as opposed to leaves whose text lives in `text`.
const GROUPING_LABELS = new Set(["Course", "LessonGrouping", "StandardsFramework"]);

// The canonical containment edge for a NEW node of the given label: content
// labels attach by `hasPart`, standards labels by `hasChild`, a LearningComponent
// attaches to its SFI by `supports`. Callers may override via an explicit edge.
export function containmentEdgeFor(label: string): string {
  if (STANDARDS_LABELS.has(label)) return "hasChild";
  if (label === "LearningComponent") return "supports";
  return "hasPart"; // content labels + sensible default
}

// The canonical alignment edge (content → StandardsFrameworkItem). Used by
// add_node's optional `alignTo`.
export const ALIGNMENT_EDGE = "hasEducationalAlignment";

// The normalized ordinal field every node carries at the top level (mirrored
// into `raw` at a source-specific path — see the template's `orderPath`).
export const POSITION = "order";

// Fallback internal `kind` for a label when the graph has no example to copy
// from. Only content labels are ever created without an example (reading's first
// Activity/Material); groupings always have an example (maths' chapters), so the
// LessonGrouping ambiguity (week vs chapter vs day) never reaches this map.
const FALLBACK_KIND: Record<string, string> = {
  Lesson: "lesson", Activity: "activity", Material: "material",
  LessonGrouping: "grouping", Course: "course",
};

// The identity skeleton for a created node — enough to make it survive a
// re-parse: internal kind, LC labels, grouping-ness (title vs text), the raw
// ordinal path(s), and the raw identity fields.
export type NodeTemplate = {
  kind: string;
  labels: string[];
  isGrouping: boolean;
  orderPaths: string[]; // every raw ordinal path the source uses (e.g. ["raw.position", "raw.metadata.order"])
  normalizedType?: string;
  normalizedStatementType?: string;
  role?: string;
};

const rawOf = (n: MutationNode): Record<string, any> => (n.properties?.raw as Record<string, any>) ?? {};

// The raw path(s) a node stores its ordinal at — read off a node so a created
// sibling mirrors the SAME source convention (some sources, e.g. CI maths, carry
// BOTH `raw.position` AND `raw.metadata.order` as mirrors; the parser reads one,
// so a faithful node must set every one the source uses). move/reposition write
// back to the node's OWN set. Empty → the caller defaults to `["raw.position"]`.
export function orderPathsOf(n: MutationNode): string[] {
  const raw = rawOf(n);
  const paths: string[] = [];
  if (raw.position !== undefined) paths.push("raw.position");
  if (raw.metadata?.order !== undefined) paths.push("raw.metadata.order");
  return paths;
}

// Derive the template for `label` from the graph (copy an existing example's
// skeleton), or fall back to canonical LC defaults when none exists yet.
export function deriveTemplate(graph: MutationGraph, label: string): NodeTemplate {
  const example = graph.nodes.find((n) => (n.labels ?? []).includes(label));
  if (example) {
    const raw = rawOf(example);
    const orderPaths = orderPathsOf(example);
    return {
      kind: example.type,
      labels: example.labels ?? [label],
      isGrouping: raw.normalizedStatementType === "Standard Grouping",
      orderPaths: orderPaths.length ? orderPaths : ["raw.position"],
      normalizedType: raw.normalizedType,
      normalizedStatementType: raw.normalizedStatementType,
      role: raw.metadata?.role,
    };
  }
  const isGrouping = GROUPING_LABELS.has(label);
  return {
    kind: FALLBACK_KIND[label] ?? label.toLowerCase(),
    labels: [label],
    isGrouping,
    orderPaths: ["raw.position"],
    normalizedType: label,
    normalizedStatementType: isGrouping ? "Standard Grouping" : undefined,
  };
}

// The set of LC labels a curator may create — a canonical label the ontology
// defines, OR any label already present in the graph (forward-compatible with
// labels this build doesn't enumerate). Used by add_node's validation.
export function isKnownLabel(graph: MutationGraph, label: string): boolean {
  if (CONTENT_LABELS.has(label) || STANDARDS_LABELS.has(label) || label === "LearningComponent") return true;
  return graph.nodes.some((n) => (n.labels ?? []).includes(label));
}
