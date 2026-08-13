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

// The edges the subtree walk follows out from a course. Containment does the
// bulk of it — `hasPart` (content nesting) + `hasChild` (standards hierarchy).
// `usesRoutine` is also followed so the InstructionalRoutine a lesson applies —
// and, through the routine's own `hasPart`, its step routines and Materials — are
// pulled into the subtree; without it the routine (attached by usesRoutine, not
// containment) would be invisible in get_course.
const EXPAND_EDGES = new Set(["hasPart", "hasChild", "usesRoutine"]);

const nodeOut = (n: RawGraphSnapshot["nodes"][number]): NodeOut => ({ id: n.id, labels: n.labels ?? [], properties: n.properties ?? {} });
const edgeOut = (e: RawGraphSnapshot["relationships"][number]): EdgeOut => ({ id: e.id, type: e.type, start: e.start, end: e.end, properties: e.properties ?? {} });

// Every Course node in the graph, as-is. [] when the graph has no Course node
// (e.g. reading/nigeria until an expert authors one).
export function coursesOf(model: CurriculumModel): NodeOut[] {
  const raw = model.rawGraph;
  if (!raw) return [];
  return raw.nodes.filter((n) => (n.labels ?? []).includes("Course")).map(nodeOut);
}

// The subtree rooted at one Course: the course node plus every descendant
// reached through hasPart/hasChild AND every InstructionalRoutine a descendant
// applies via usesRoutine (with the routine's own step routines + Materials), and
// every edge (any type) among those nodes. Returns null if the id isn't a Course
// node in this graph.
export function courseSubgraph(model: CurriculumModel, courseId: string): { course: string; nodes: NodeOut[]; edges: EdgeOut[] } | null {
  const raw = model.rawGraph;
  if (!raw) return null;
  const src = raw.nodes.find((n) => n.id === courseId);
  if (!src || !(src.labels ?? []).includes("Course")) return null;

  const childrenOf = new Map<string, string[]>();
  for (const e of raw.relationships) {
    if (!EXPAND_EDGES.has(e.type)) continue;
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

// The standards-spine neighborhood a content node (e.g. a Lesson) teaches. A
// content node reaches the spine by `hasEducationalAlignment` → SFI; the SFI's
// substance (the OS text) is on the SFI itself, its skills are the
// `LearningComponent`s that `supports` it (or are its `hasChild` children), and
// its illustrative tasks are the `Activity`s that align to it. This is the ONE
// hop `get_course` deliberately does not take (following alignment from a course
// pulls ~3/4 of the graph), so it is a separate per-node reader. Returns the
// origin + its aligned SFI(s) + that 1-hop neighborhood as raw nodes + edges.
// Empty `nodes` when the node aligns to nothing (e.g. a placeholder not yet wired
// to the spine). Returns null if the node id isn't in the graph.
export function standardsFor(model: CurriculumModel, nodeId: string): { node: string; nodes: NodeOut[]; edges: EdgeOut[] } | null {
  const raw = model.rawGraph;
  if (!raw) return null;
  if (!raw.nodes.some((n) => n.id === nodeId)) return null;
  const isSfi = (id: string) => (raw.nodes.find((n) => n.id === id)?.labels ?? []).includes("StandardsFrameworkItem");

  const aligned = raw.relationships
    .filter((e) => e.type === "hasEducationalAlignment" && e.start === nodeId && isSfi(e.end))
    .map((e) => e.end);
  // Aligns to no standard (e.g. a placeholder not yet wired to the spine) — return
  // empty rather than the lone origin node, so "no standards" reads unambiguously.
  if (aligned.length === 0) return { node: nodeId, nodes: [], edges: [] };
  const inSet = new Set<string>([nodeId, ...aligned]);
  // 1-hop standards neighborhood of each aligned SFI: its components (supports
  // reverse / hasChild children), the tasks aligning to it (alignment reverse),
  // and its parent SFI for context (hasChild reverse).
  for (const e of raw.relationships) {
    if (e.type === "supports" && aligned.includes(e.end)) inSet.add(e.start);
    else if (e.type === "hasChild" && aligned.includes(e.start)) inSet.add(e.end);
    else if (e.type === "hasChild" && aligned.includes(e.end)) inSet.add(e.start);
    else if (e.type === "hasEducationalAlignment" && aligned.includes(e.end)) inSet.add(e.start);
  }
  const nodes = raw.nodes.filter((n) => inSet.has(n.id)).map(nodeOut);
  const edges = raw.relationships.filter((e) => inSet.has(e.start) && inSet.has(e.end)).map(edgeOut);
  return { node: nodeId, nodes, edges };
}
