/*
 * Module: curriculum · namespace statistics
 *
 * The model-derived half of the namespace_stats tool: node counts by LC label,
 * edge counts by type, the structural roots, and a few cheap orientation flags —
 * all read straight off the echoed raw graph (`model.rawGraph`), no traversal.
 * The tool layer adds the namespace string and the live draft state (which need
 * the store), because those are not on the read model.
 *
 * Purpose: one call that answers "what am I looking at?" before writing any
 * query — e.g. "112 StandardsFrameworkItems, 1 framework, 0 groupings, 112
 * alignment edges" — replacing a whole discovery phase.
 */
import type { CurriculumModel, RawGraphSnapshot } from "../types.js";

type RawNode = RawGraphSnapshot["nodes"][number];

// A structural root: a node no containment edge points at (a Course, a
// StandardsFramework, or an orphan grouping). `description` is a best-effort
// display string so a human can tell the roots apart at a glance.
export type StatsRoot = { id: string; labels: string[]; description: string };

export type GraphStats = {
  nodeCounts: Record<string, number>;   // keyed by the node's primary LC label
  edgeCounts: Record<string, number>;   // keyed by edge type
  roots: StatsRoot[];                   // capped to MAX_ROOTS, interesting kinds first
  rootsTotal: number;                   // full count before the cap (roots.length may be smaller)
  structuralFlags: string[];            // cheap "looks off" hints (e.g. no Course authored)
};

// Containment edges — the ones that give a node a structural parent. A node with
// no INBOUND hasPart/hasChild is a root; alignment/support edges don't count.
const CONTAINMENT_EDGES = new Set(["hasPart", "hasChild"]);

// namespace_stats is an orientation call that must ALWAYS return small, but a
// standards-only graph (e.g. Nigeria) has hundreds of `supports`-only
// LearningComponents that are technically roots — noise that would blow the
// response. So we surface the roots that matter for orientation first (the content
// Course, the framework root, then groupings) and cap the list, reporting the true
// total separately. The dropped tail is uninteresting leaves, never a Course.
const MAX_ROOTS = 50;
const ROOT_LABEL_RANK: Record<string, number> = { Course: 0, StandardsFramework: 1, LessonGrouping: 2 };
const rootRank = (root: StatsRoot): number => {
  const best = Math.min(...root.labels.map((label) => ROOT_LABEL_RANK[label] ?? 99), 99);
  return best;
};

// A node's primary LC label (Course / Lesson / StandardsFrameworkItem / …). LC
// nodes carry their main label first; count by it so a node isn't tallied under
// each of its several labels.
const primaryLabel = (node: RawNode): string => node.labels?.[0] ?? "(unlabeled)";

// Best-effort human title for a root, trying the normalized fields first, then
// the raw LC description. Empty string when the node carries no text at all.
function displayText(node: RawNode): string {
  const properties = (node.properties ?? {}) as Record<string, unknown>;
  const normalizedTitle = properties.title ?? properties.text;
  if (typeof normalizedTitle === "string" && normalizedTitle.length > 0) {
    return normalizedTitle;
  }
  const raw = (properties.raw ?? {}) as Record<string, unknown>;
  return typeof raw.description === "string" ? raw.description : "";
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function computeGraphStats(model: CurriculumModel): GraphStats {
  const raw = model.rawGraph;
  if (!raw) {
    return { nodeCounts: {}, edgeCounts: {}, roots: [], rootsTotal: 0, structuralFlags: ["graph not available as a raw envelope"] };
  }

  const nodeCounts = countBy(raw.nodes, primaryLabel);
  const edgeCounts = countBy(raw.relationships, (edge) => edge.type);

  // Every node that is the `end` of a containment edge has a structural parent;
  // the rest are roots.
  const hasStructuralParent = new Set<string>();
  for (const edge of raw.relationships) {
    if (CONTAINMENT_EDGES.has(edge.type)) {
      hasStructuralParent.add(edge.end);
    }
  }
  const allRoots: StatsRoot[] = raw.nodes
    .filter((node) => !hasStructuralParent.has(node.id))
    .map((node) => ({ id: node.id, labels: node.labels ?? [], description: displayText(node) }));

  // Interesting kinds first (stable within a rank), then cap. Flags are computed
  // from the FULL root set so "no Course" etc. stay accurate after the cap.
  const roots = [...allRoots].sort((a, b) => rootRank(a) - rootRank(b)).slice(0, MAX_ROOTS);

  return {
    nodeCounts, edgeCounts, roots, rootsTotal: allRoots.length,
    structuralFlags: structuralFlags(raw, nodeCounts, allRoots),
  };
}

// A handful of cheap, honest "this might be incomplete" hints — orientation
// only, not the adapter's authoritative coverageWarnings. Computed from the
// aggregates already in hand, so it stays a no-traversal call.
function structuralFlags(raw: RawGraphSnapshot, nodeCounts: Record<string, number>, roots: StatsRoot[]): string[] {
  const flags: string[] = [];

  if (!nodeCounts["Course"]) {
    flags.push("no Course (content root) authored");
  }

  // A framework with nothing hanging off it (no hasChild spine) is the classic
  // "seeded the root but not the standards" state worth surfacing up front.
  const frameworkIds = raw.nodes.filter((node) => (node.labels ?? []).includes("StandardsFramework")).map((node) => node.id);
  const hasChildFromFramework = new Set(
    raw.relationships.filter((edge) => edge.type === "hasChild").map((edge) => edge.start),
  );
  for (const frameworkId of frameworkIds) {
    if (!hasChildFromFramework.has(frameworkId)) {
      flags.push(`StandardsFramework '${frameworkId}' has no hasChild children`);
    }
  }

  if (roots.length === 0 && raw.nodes.length > 0) {
    flags.push("no structural roots — every node has a containment parent (unexpected for a seeded graph)");
  }

  return flags;
}
