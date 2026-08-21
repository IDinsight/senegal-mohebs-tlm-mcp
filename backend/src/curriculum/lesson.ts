/*
 * Module: curriculum · generic lesson-scoped generation reader
 *
 * The third generation-side reader, rooted at ONE content node (typically a
 * Lesson) rather than a whole Course (courses.ts) or a whole document/TLM
 * (documents.ts). Where those read "the curriculum to teach" and "the document to
 * produce", this reads "one lesson to produce": given a single Lesson id it
 * gathers the three things a per-lesson generation needs —
 *
 *   1. the lesson's own content subtree (its `hasPart` Activities/Materials/…);
 *   2. the APPLICABLE instructional routine, resolved NEAREST-WINS: the lesson's
 *      own `usesRoutine` if it carries one, else the nearest containment ancestor's
 *      (a week, then the Course). This is the one reader that DOES follow
 *      `usesRoutine` — routine is pedagogy, so it is inherited down the content
 *      tree, letting the Course carry one default routine for every lesson while an
 *      individual lesson can still override it;
 *   3. the FORMATTERS that apply, pulled from every TeachingLearningMaterial whose
 *      `covers` reaches this lesson (directly via a DocumentSection, or coarsely via
 *      the lesson's Course). Formatting stays a property of the document — we reach
 *      it through the covering TLM, exactly as documents.ts does, never by treating
 *      a formatter as a routine.
 *
 * Like the other two readers it does NO projection: it surfaces raw
 * Learning-Commons nodes + edges and lets the caller (the LLM) assemble the
 * material. The Course/document readers stay pure containment and deliberately skip
 * `usesRoutine`; this reader is the additive counterpart that resolves the
 * inheritance, so those two are left untouched.
 */
import type { CurriculumModel, RawGraphSnapshot } from "../types.js";

type RawNode = RawGraphSnapshot["nodes"][number];
type RawEdge = RawGraphSnapshot["relationships"][number];

// A bare node/edge as returned to the caller — raw LC labels + properties.
type NodeOut = { id: string; labels: string[]; properties: Record<string, unknown> };
type EdgeOut = { id: string; type: string; start: string; end: string; properties: Record<string, unknown> };

const LESSON_LABEL = "Lesson";
const TLM_LABEL = "TeachingLearningMaterial";
const FORMATTER_LABELS = new Set(["Formatter", "FormatterSpec"]);
const ROUTINE_EDGE = "usesRoutine";
const COVERS_EDGE = "covers";

// A lesson's own content hangs off it by `hasPart` (Activity/Assessment/Material).
const CONTENT_EDGE = "hasPart";
// Containment for the ancestor walk is both content nesting (`hasPart`) and the
// standards/schedule axis (`hasChild`) — a maths lesson reaches its week through
// `hasChild` and its chapter + Course through `hasPart`, so both must be climbed to
// find the nearest node carrying a routine.
const CONTAINMENT_EDGES = new Set(["hasPart", "hasChild"]);
// The document's own rendering stack (Formatter/FormatterSpec) hangs off the TLM by
// `hasPart` — the same edge documents.ts walks for the document subtree.
const DOCUMENT_EDGE = "hasPart";

const nodeOut = (node: RawNode): NodeOut => ({ id: node.id, labels: node.labels ?? [], properties: node.properties ?? {} });
const edgeOut = (edge: RawEdge): EdgeOut => ({ id: edge.id, type: edge.type, start: edge.start, end: edge.end, properties: edge.properties ?? {} });

const labelsOf = (node: RawNode): string[] => node.labels ?? [];

// BFS out from `roots` (inclusive) following the given edge types from→to. Shared
// by the content-subtree walk and the document-subtree walk.
function descendants(raw: RawGraphSnapshot, roots: string[], edgeTypes: Set<string>): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const edge of raw.relationships) {
    if (!edgeTypes.has(edge.type)) {
      continue;
    }
    const siblings = childrenOf.get(edge.start) ?? childrenOf.set(edge.start, []).get(edge.start)!;
    siblings.push(edge.end);
  }

  const reached = new Set<string>(roots);
  const stack = [...roots];
  while (stack.length) {
    const current = stack.pop()!;
    for (const child of childrenOf.get(current) ?? []) {
      if (!reached.has(child)) {
        reached.add(child);
        stack.push(child);
      }
    }
  }
  return reached;
}

// The subgraph induced by `ids`: those nodes plus every edge of the given types
// whose endpoints are both inside the set.
function inducedSubgraph(raw: RawGraphSnapshot, ids: Set<string>, edgeTypes: Set<string>): { nodes: NodeOut[]; edges: EdgeOut[] } {
  const nodes = raw.nodes.filter((node) => ids.has(node.id)).map(nodeOut);
  const edges = raw.relationships
    .filter((edge) => edgeTypes.has(edge.type) && ids.has(edge.start) && ids.has(edge.end))
    .map(edgeOut);
  return { nodes, edges };
}

// The lesson and every containment ancestor above it (week, chapter, Course),
// returned nearest-first so a routine search can stop at the first hit. Walks
// inbound `hasPart`/`hasChild` edges (parent = edge.start, child = edge.end).
function ancestorsNearestFirst(raw: RawGraphSnapshot, lessonId: string): string[] {
  const parentsOf = new Map<string, string[]>();
  for (const edge of raw.relationships) {
    if (!CONTAINMENT_EDGES.has(edge.type)) {
      continue;
    }
    const parents = parentsOf.get(edge.end) ?? parentsOf.set(edge.end, []).get(edge.end)!;
    parents.push(edge.start);
  }

  // Level-order (BFS) up the tree, so closer ancestors come before farther ones.
  const ordered: string[] = [lessonId];
  const seen = new Set<string>([lessonId]);
  let frontier = [lessonId];
  while (frontier.length) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      for (const parent of parentsOf.get(node) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          ordered.push(parent);
          nextFrontier.push(parent);
        }
      }
    }
    frontier = nextFrontier;
  }
  return ordered;
}

// The routine that applies to a lesson, resolved nearest-wins. `resolvedFrom` is
// the node whose `usesRoutine` edge we followed — the lesson itself when it carries
// its own, otherwise the nearest ancestor (typically the Course). null when nothing
// in the lesson's ancestry uses a routine.
export type ResolvedRoutine = {
  entryId: string;          // the InstructionalRoutine the edge points at
  resolvedFrom: string;     // the node that carried the usesRoutine edge
  inherited: boolean;       // false when the lesson carries it directly, true when inherited from an ancestor
  nodes: NodeOut[];         // the routine subtree (entry + its hasPart steps/materials)
  edges: EdgeOut[];
};

function resolveRoutine(raw: RawGraphSnapshot, lessonId: string): ResolvedRoutine | null {
  const routineTargetOf = (nodeId: string): string | null => {
    const edge = raw.relationships.find((candidate) => candidate.type === ROUTINE_EDGE && candidate.start === nodeId);
    return edge ? edge.end : null;
  };

  const ancestry = ancestorsNearestFirst(raw, lessonId);
  for (const nodeId of ancestry) {
    const entryId = routineTargetOf(nodeId);
    if (entryId === null) {
      continue;
    }

    // Found the nearest routine — return its whole subtree (entry + steps + materials).
    const routineIds = descendants(raw, [entryId], new Set([CONTENT_EDGE]));
    const routineSubgraph = inducedSubgraph(raw, routineIds, new Set([CONTENT_EDGE]));
    return {
      entryId,
      resolvedFrom: nodeId,
      inherited: nodeId !== lessonId,
      nodes: routineSubgraph.nodes,
      edges: routineSubgraph.edges,
    };
  }
  return null;
}

// One covering document's formatters: the TLM plus its Formatter/FormatterSpec
// rendering stack. `via` records how the document reaches the lesson — the covered
// node (the lesson itself, or an ancestor Course/grouping).
export type CoveringFormatters = {
  tlm: string;
  via: string;
  nodes: NodeOut[];   // the Formatter + FormatterSpec nodes hung under the TLM
  edges: EdgeOut[];   // the hasPart edges among them
};

// Every document that covers this lesson, with its formatters. A TLM covers the
// lesson when any node in its document subtree (the TLM + its hasPart descendants —
// e.g. a DocumentSection) has a `covers` edge to the lesson or to one of its
// ancestors. Optionally restricted to a single `tlmId` (generating for one
// document); otherwise all covering documents are returned.
function resolveFormatters(raw: RawGraphSnapshot, lessonId: string, tlmId?: string): CoveringFormatters[] {
  const coveredByLesson = new Set(ancestorsNearestFirst(raw, lessonId));

  const tlmNodes = raw.nodes.filter((node) => {
    const isTlm = labelsOf(node).includes(TLM_LABEL);
    const matchesTarget = tlmId === undefined || node.id === tlmId;
    return isTlm && matchesTarget;
  });

  const covering: CoveringFormatters[] = [];
  for (const tlm of tlmNodes) {
    const documentIds = descendants(raw, [tlm.id], new Set([DOCUMENT_EDGE]));

    // Does this document render the lesson? True if any of its covers edges lands
    // on the lesson or one of its ancestors.
    const coversEdge = raw.relationships.find(
      (edge) => edge.type === COVERS_EDGE && documentIds.has(edge.start) && coveredByLesson.has(edge.end),
    );
    if (!coversEdge) {
      continue;
    }

    const formatterIds = new Set([...documentIds].filter((id) => {
      const node = raw.nodes.find((candidate) => candidate.id === id);
      return node !== undefined && labelsOf(node).some((label) => FORMATTER_LABELS.has(label));
    }));
    const formatterSubgraph = inducedSubgraph(raw, formatterIds, new Set([DOCUMENT_EDGE]));

    covering.push({
      tlm: tlm.id,
      via: coversEdge.end,
      nodes: formatterSubgraph.nodes,
      edges: formatterSubgraph.edges,
    });
  }
  return covering;
}

// Everything a per-lesson generation composes: the lesson node, its content
// subtree, the resolved routine (inherited or own), and the formatters of every
// covering document.
export type LessonScope = {
  lesson: string;
  lessonNode: NodeOut;
  content: { nodes: NodeOut[]; edges: EdgeOut[] };
  routine: ResolvedRoutine | null;
  formatters: CoveringFormatters[];
};

// The generation scope rooted at one Lesson. Returns null if `lessonId` is not a
// Lesson node in this graph. `tlmId` optionally scopes the formatters to a single
// document (the one being generated); omit it to get every covering document.
export function lessonSubgraph(model: CurriculumModel, lessonId: string, tlmId?: string): LessonScope | null {
  const raw = model.rawGraph;
  if (!raw) {
    return null;
  }
  const lesson = raw.nodes.find((node) => node.id === lessonId);
  if (!lesson || !labelsOf(lesson).includes(LESSON_LABEL)) {
    return null;
  }

  const contentIds = descendants(raw, [lessonId], new Set([CONTENT_EDGE]));
  const content = inducedSubgraph(raw, contentIds, new Set([CONTENT_EDGE]));

  const routine = resolveRoutine(raw, lessonId);
  const formatters = resolveFormatters(raw, lessonId, tlmId);

  return {
    lesson: lessonId,
    lessonNode: nodeOut(lesson),
    content,
    routine,
    formatters,
  };
}
