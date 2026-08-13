/*
 * Module: curriculum · generic Course readers
 *
 * Subject-agnostic graph readers behind the list_courses / get_course tools.
 * They do NO projection — no chapter/week/lesson vocabulary, no cooked slice.
 * They just surface raw Learning-Commons nodes so the caller (the LLM) reads the
 * structure and assembles materials itself. Everything comes from the model's
 * echoed raw graph (`rawGraph`); a subject whose graph has no Course node simply
 * returns nothing.
 */
import type { CurriculumModel, RawGraphSnapshot } from "../types.js";

// A bare node/edge as returned to the caller — raw LC labels + properties.
type NodeOut = { id: string; labels: string[]; properties: Record<string, unknown> };
type EdgeOut = { id: string; type: string; start: string; end: string; properties: Record<string, unknown> };

// Containment edges define the "under a course" subtree. hasPart is content
// nesting, hasChild is the standards hierarchy — a course's descendants are
// reached through both.
const CONTAINMENT = new Set(["hasPart", "hasChild"]);

const nodeOut = (n: RawGraphSnapshot["nodes"][number]): NodeOut => ({ id: n.id, labels: n.labels ?? [], properties: n.properties ?? {} });
const edgeOut = (e: RawGraphSnapshot["relationships"][number]): EdgeOut => ({ id: e.id, type: e.type, start: e.start, end: e.end, properties: e.properties ?? {} });

// Every Course node in the graph, as-is. [] when the graph has no Course node
// (e.g. reading/nigeria until an expert authors one).
export function coursesOf(model: CurriculumModel): NodeOut[] {
  const raw = model.rawGraph;
  if (!raw) return [];
  return raw.nodes.filter((n) => (n.labels ?? []).includes("Course")).map(nodeOut);
}

// The containment subtree rooted at one Course: the course node plus every
// descendant reached through hasPart/hasChild, and every edge (any type) among
// those nodes. Returns null if the id isn't a Course node in this graph.
export function courseSubgraph(model: CurriculumModel, courseId: string): { course: string; nodes: NodeOut[]; edges: EdgeOut[] } | null {
  const raw = model.rawGraph;
  if (!raw) return null;
  const src = raw.nodes.find((n) => n.id === courseId);
  if (!src || !(src.labels ?? []).includes("Course")) return null;

  const childrenOf = new Map<string, string[]>();
  for (const e of raw.relationships) {
    if (!CONTAINMENT.has(e.type)) continue;
    (childrenOf.get(e.start) ?? childrenOf.set(e.start, []).get(e.start)!).push(e.end);
  }
  const inSet = new Set<string>([courseId]);
  const stack = [courseId];
  while (stack.length) {
    for (const c of childrenOf.get(stack.pop()!) ?? []) if (!inSet.has(c)) { inSet.add(c); stack.push(c); }
  }
  const nodes = raw.nodes.filter((n) => inSet.has(n.id)).map(nodeOut);
  const edges = raw.relationships.filter((e) => inSet.has(e.start) && inSet.has(e.end)).map(edgeOut);
  return { course: courseId, nodes, edges };
}
