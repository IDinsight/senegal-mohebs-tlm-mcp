/*
 * Module: curriculum · generic document (TLM) reader
 *
 * The generation-side counterpart to courses.ts, rooted at a
 * TeachingLearningMaterial (TLM) instead of a Course. Where courseSubgraph reads
 * "the curriculum to teach", documentSubgraph reads "the document to produce":
 * given one TLM node it returns the three things generation composes over a
 * document (see docs/design-notes/teaching-learning-materials.md · "What changes
 * for generation"):
 *
 *   1. the TLM's own descriptive fields + `metadata.assemblyGuide` (this
 *      document's authored "how to build me" logic);
 *   2. the document's rendering stack — the Formatter/FormatterSpec subtree hung
 *      under the TLM (doc-wide) and under each DocumentSection (per-section),
 *      reached by `hasPart`;
 *   3. the CURRICULUM to render, resolved by the section-spine-or-Course rule: a
 *      DocumentSection spine when the TLM has one (walk the ordered sections, each
 *      `covers` its curriculum node(s)), otherwise the Course the TLM `covers`.
 *
 * Like the Course readers it does NO projection — it surfaces raw Learning-Commons
 * nodes + edges and lets the caller (the LLM) assemble the material. It also does
 * NOT follow `usesRoutine`: a formatter is a property of the DOCUMENT, reached
 * through the TLM, so the curriculum walk here stays pure containment and never
 * pulls formatting in through the curriculum (the "formatters leave the Course
 * walk" separation, expressed additively — courseSubgraph is left untouched).
 */
import type { CurriculumModel, RawGraphSnapshot } from "../types.js";

type RawNode = RawGraphSnapshot["nodes"][number];
type RawEdge = RawGraphSnapshot["relationships"][number];

// A bare node/edge as returned to the caller — raw LC labels + properties.
type NodeOut = { id: string; labels: string[]; properties: Record<string, unknown> };
type EdgeOut = { id: string; type: string; start: string; end: string; properties: Record<string, unknown> };

const TLM_LABEL = "TeachingLearningMaterial";
const SECTION_LABEL = "DocumentSection";
// The document's own spine + rendering stack hang off the TLM by `hasPart`
// (DocumentSection · Formatter · FormatterSpec). This is the ONLY edge the
// document-side walk follows.
const DOCUMENT_EDGE = "hasPart";
// The curriculum-to-render walk is pure containment — hasPart (content) + hasChild
// (standards). Deliberately NOT usesRoutine: formatting reaches generation via the
// TLM, never through the curriculum subtree.
const CURRICULUM_EDGES = new Set(["hasPart", "hasChild"]);

const nodeOut = (n: RawNode): NodeOut => ({ id: n.id, labels: n.labels ?? [], properties: n.properties ?? {} });
const edgeOut = (e: RawEdge): EdgeOut => ({ id: e.id, type: e.type, start: e.start, end: e.end, properties: e.properties ?? {} });

const labelsOf = (n: RawNode): string[] => n.labels ?? [];
const props = (n: RawNode): Record<string, any> => (n.properties ?? {}) as Record<string, any>;

// A section's ordinal, read the same way the parser reads a content leaf's: the
// canonical LC `position`, falling back to the maths-style `metadata.order`, then 0
// so an unordered section still sorts stably (by author/insertion order).
function positionOf(n: RawNode): number {
  const p = props(n);
  if (typeof p.position === "number") return p.position;
  if (typeof p.metadata?.order === "number") return p.metadata.order;
  return 0;
}

// This document's authored assembly logic, from the `metadata.assemblyGuide`
// sidecar (markdown). null when the TLM carries none.
function assemblyGuideOf(n: RawNode): string | null {
  const guide = props(n).metadata?.assemblyGuide;
  return typeof guide === "string" && guide !== "" ? guide : null;
}

// BFS out from `roots` (inclusive) over the given edge types — the shared
// containment walk both the document subtree and the curriculum subtree use.
function descendants(raw: RawGraphSnapshot, roots: string[], edgeTypes: Set<string>): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const e of raw.relationships) {
    if (!edgeTypes.has(e.type)) continue;
    (childrenOf.get(e.start) ?? childrenOf.set(e.start, []).get(e.start)!).push(e.end);
  }
  const inSet = new Set<string>(roots);
  const stack = [...roots];
  while (stack.length) {
    for (const c of childrenOf.get(stack.pop()!) ?? []) if (!inSet.has(c)) { inSet.add(c); stack.push(c); }
  }
  return inSet;
}

// One DocumentSection in the document's spine: its id, its ordinal, and the
// curriculum node(s) it renders (`covers` targets). An EMPTY `covers` marks a
// front-matter section (cover, table of contents, intro) with no curriculum node.
export type DocumentSectionOut = { id: string; position: number; covers: string[] };

// The full document scope generation composes over. `scope` records HOW the
// curriculum was resolved: "sections" (a DocumentSection spine), "course" (the
// simple TLM→covers→Course fallback), or "none" (the TLM covers nothing yet).
export type DocumentScope = {
  tlm: string;
  assemblyGuide: string | null;
  scope: "sections" | "course" | "none";
  sections: DocumentSectionOut[];              // ordered by position; [] when there is no spine
  document: { nodes: NodeOut[]; edges: EdgeOut[] };   // the TLM subtree: TLM + hasPart(sections/formatters/specs) + covers edges
  curriculum: { nodes: NodeOut[]; edges: EdgeOut[] };  // the resolved curriculum-to-render subgraph
};

// The document rooted at one TLM. Returns null if `tlmId` is not a
// TeachingLearningMaterial node in this graph.
export function documentSubgraph(model: CurriculumModel, tlmId: string): DocumentScope | null {
  const raw = model.rawGraph;
  if (!raw) return null;
  const tlm = raw.nodes.find((n) => n.id === tlmId);
  if (!tlm || !labelsOf(tlm).includes(TLM_LABEL)) return null;

  // 1. The document's own subtree: the TLM plus everything hung under it by
  //    hasPart (DocumentSections, Formatters, FormatterSpecs). `covers` is kept on
  //    its own axis — the document→curriculum bridge, never containment.
  const docIds = descendants(raw, [tlmId], new Set([DOCUMENT_EDGE]));
  const coversEdges = raw.relationships.filter((e) => e.type === "covers" && docIds.has(e.start));
  const documentEdges = raw.relationships
    .filter((e) => e.type === DOCUMENT_EDGE && docIds.has(e.start) && docIds.has(e.end))
    .concat(coversEdges);
  const document = {
    nodes: raw.nodes.filter((n) => docIds.has(n.id)).map(nodeOut),
    edges: documentEdges.map(edgeOut),
  };

  const coversTargets = (fromId: string): string[] =>
    coversEdges.filter((e) => e.start === fromId).map((e) => e.end);

  // 2. Ordered DocumentSection spine (by position), each with its covers targets.
  const sections: DocumentSectionOut[] = raw.nodes
    .filter((n) => docIds.has(n.id) && labelsOf(n).includes(SECTION_LABEL))
    .map((n) => ({ id: n.id, position: positionOf(n), covers: coversTargets(n.id) }))
    .sort((a, b) => a.position - b.position);

  // 3. Resolve the curriculum to render: the section spine when present (the union
  //    of the sections' covers targets, front-matter sections contributing none),
  //    otherwise the Course the TLM itself covers.
  let scope: DocumentScope["scope"];
  let curriculumRoots: string[];
  if (sections.length > 0) {
    scope = "sections";
    curriculumRoots = sections.flatMap((s) => s.covers);
  } else {
    curriculumRoots = coversTargets(tlmId);
    scope = curriculumRoots.length > 0 ? "course" : "none";
  }

  const curriculumIds = descendants(raw, curriculumRoots, CURRICULUM_EDGES);
  const curriculum = {
    nodes: raw.nodes.filter((n) => curriculumIds.has(n.id)).map(nodeOut),
    edges: raw.relationships.filter((e) => curriculumIds.has(e.start) && curriculumIds.has(e.end)).map(edgeOut),
  };

  return { tlm: tlmId, assemblyGuide: assemblyGuideOf(tlm), scope, sections, document, curriculum };
}
