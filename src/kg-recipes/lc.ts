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
// from. Kinds are the graph's own canonical values, and a content leaf's kind is
// its LC label (Lesson/Activity/Material/Course), so the fallback is the label
// itself. Only content labels are ever created without an example (reading's first
// Activity/Material); a grouping's kind is its `groupName`, but groupings always
// have an example (maths' chapters), so that ambiguity never reaches this map.
const FALLBACK_KIND: Record<string, string> = {
  Lesson: "Lesson", Activity: "Activity", Material: "Material",
  LessonGrouping: "LessonGrouping", Course: "Course",
};

// LC "boilerplate" — the constant provenance/licensing fields every node of a
// graph shares (as opposed to node-specific content/identity/ordinal fields). A
// created node COPIES whichever of these its siblings actually carry, so it looks
// exactly like a seeded node of the same label (some sources carry all, some only
// a few — see the per-node variation in sources/*/knowledge_graph.json).
const BOILERPLATE_KEYS = [
  "license", "provider", "attributionStatement", "author",
  "inLanguage", "jurisdiction", "academicSubject", "gradeLevel",
] as const;

// Canonical fallback when the graph has no example of this label to copy from.
const FALLBACK_BOILERPLATE: Record<string, unknown> = {
  license: "https://creativecommons.org/licenses/by/4.0/",
  provider: "Learning Commons ontology (generated)",
  attributionStatement: "Node/edge types follow the Learning Commons ontology (CC BY-4.0).",
};

// The identity skeleton for a created node — enough to make it survive a
// re-parse: internal kind, LC labels, grouping-ness (title vs text), the raw
// ordinal path(s), the raw identity fields, and the shared boilerplate.
export type NodeTemplate = {
  kind: string;
  labels: string[];
  isGrouping: boolean;
  orderPaths: string[]; // every raw ordinal path the source uses (e.g. ["raw.position", "raw.metadata.order"])
  normalizedType?: string;
  normalizedStatementType?: string;
  role?: string;
  boilerplate: Record<string, unknown>; // license/provider/attribution/… copied from an example (or canonical fallback)
};

// The subset of BOILERPLATE_KEYS an example node actually carries in its raw props.
function boilerplateOf(example: MutationNode): Record<string, unknown> {
  const raw = rawOf(example);
  const boilerplate: Record<string, unknown> = {};
  for (const key of BOILERPLATE_KEYS) {
    if (raw[key] !== undefined) boilerplate[key] = raw[key];
  }
  return boilerplate;
}

const rawOf = (node: MutationNode): Record<string, any> => (node.properties?.raw as Record<string, any>) ?? {};

// The raw path(s) a node stores its ordinal at — read off a node so a created
// sibling mirrors the SAME source convention (some sources, e.g. CI maths, carry
// BOTH `raw.position` AND `raw.metadata.order` as mirrors; the parser reads one,
// so a faithful node must set every one the source uses). move/reposition write
// back to the node's OWN set. Empty → the caller defaults to `["raw.position"]`.
export function orderPathsOf(node: MutationNode): string[] {
  const raw = rawOf(node);
  const paths: string[] = [];
  if (raw.position !== undefined) paths.push("raw.position");
  if (raw.metadata?.order !== undefined) paths.push("raw.metadata.order");
  return paths;
}

// Derive the template for `label` from the graph (copy an existing example's
// skeleton), or fall back to canonical LC defaults when none exists yet.
export function deriveTemplate(graph: MutationGraph, label: string): NodeTemplate {
  // Grouping-ness is a property of the LABEL (a LessonGrouping/Course is a grouping),
  // not of the SFI-only `normalizedStatementType`. That field is copied only when the
  // example actually has it (standards nodes do; canonical content groupings don't),
  // and synthesised for a first-of-kind only for standards labels.
  const isGrouping = GROUPING_LABELS.has(label);
  const example = graph.nodes.find((node) => (node.labels ?? []).includes(label));
  if (example) {
    const raw = rawOf(example);
    const orderPaths = orderPathsOf(example);
    return {
      kind: example.type,
      labels: example.labels ?? [label],
      isGrouping,
      orderPaths: orderPaths.length ? orderPaths : ["raw.position"],
      normalizedType: raw.normalizedType,
      normalizedStatementType: raw.normalizedStatementType,
      role: raw.metadata?.role,
      boilerplate: boilerplateOf(example),
    };
  }
  return {
    kind: FALLBACK_KIND[label] ?? label.toLowerCase(),
    labels: [label],
    isGrouping,
    orderPaths: ["raw.position"],
    normalizedType: label,
    normalizedStatementType: STANDARDS_LABELS.has(label) ? "Standard Grouping" : undefined,
    boilerplate: { ...FALLBACK_BOILERPLATE },
  };
}

// The set of LC labels a curator may create — a canonical label the ontology
// defines, OR any label already present in the graph (forward-compatible with
// labels this build doesn't enumerate). Used by add_node's validation.
export function isKnownLabel(graph: MutationGraph, label: string): boolean {
  if (CONTENT_LABELS.has(label) || STANDARDS_LABELS.has(label) || label === "LearningComponent") return true;
  return graph.nodes.some((node) => (node.labels ?? []).includes(label));
}
