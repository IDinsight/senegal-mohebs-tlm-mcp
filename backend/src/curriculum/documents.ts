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

// ── walk_document_section ──────────────────────────────────────────────────────
// The per-section generation reader (docs/design-notes/walk-document-section.md).
// Where documentSubgraph reads a WHOLE document and lesson.ts reads one lesson by
// reverse-resolving its document context, this is anchored on the DocumentSection —
// the one node that already IS the document↔curriculum binding: it hangs under
// exactly one TLM (hasPart) and `covers` the curriculum it renders, so nothing has
// to be reverse-searched. It answers "what goes in this slot of this document?" and
// is the unit generation produces a `.docx` section by section from.

const FORMATTER_LABELS = new Set(["Formatter", "FormatterSpec"]);
const ROUTINE_EDGE = "usesRoutine";
// A routine subtree hangs off its entry node by hasPart, like every other content
// subtree (the routine's ordered steps + their materials).
const ROUTINE_EDGE_CONTENT = "hasPart";

// The induced subgraph over `ids`: those nodes plus every edge of the given types
// whose endpoints are both inside the set.
function inducedSubgraph(raw: RawGraphSnapshot, ids: Set<string>, edgeTypes: Set<string>): { nodes: NodeOut[]; edges: EdgeOut[] } {
  return {
    nodes: raw.nodes.filter((n) => ids.has(n.id)).map(nodeOut),
    edges: raw.relationships.filter((e) => edgeTypes.has(e.type) && ids.has(e.start) && ids.has(e.end)).map(edgeOut),
  };
}

// Every containment ancestor of `roots`, nearest-first (level-order up hasPart +
// hasChild). Used to resolve the routine that a covered curriculum node inherits —
// a covered lesson reaches its Course-level routine by climbing this chain. Walks
// inbound edges (parent = edge.start, child = edge.end).
function ancestorsNearestFirst(raw: RawGraphSnapshot, roots: string[]): string[] {
  const parentsOf = new Map<string, string[]>();
  for (const e of raw.relationships) {
    if (!CURRICULUM_EDGES.has(e.type)) continue;
    (parentsOf.get(e.end) ?? parentsOf.set(e.end, []).get(e.end)!).push(e.start);
  }

  const ordered: string[] = [];
  const seen = new Set<string>(roots);
  let frontier = [...roots];
  while (frontier.length) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const parent of parentsOf.get(node) ?? []) {
        if (!seen.has(parent)) { seen.add(parent); ordered.push(parent); next.push(parent); }
      }
    }
    frontier = next;
  }
  return ordered;
}

// The nearest TLM above a section — the document the section belongs to. A section
// hangs under exactly one TLM by hasPart, so climb inbound hasPart to the first
// TeachingLearningMaterial. null if the section is not under any document yet.
function owningTlm(raw: RawGraphSnapshot, sectionId: string): RawNode | null {
  const parentsOf = new Map<string, string[]>();
  for (const e of raw.relationships) {
    if (e.type !== DOCUMENT_EDGE) continue;
    (parentsOf.get(e.end) ?? parentsOf.set(e.end, []).get(e.end)!).push(e.start);
  }

  const stack = [...(parentsOf.get(sectionId) ?? [])];
  const seen = new Set<string>(stack);
  while (stack.length) {
    const parentId = stack.pop()!;
    const parent = raw.nodes.find((n) => n.id === parentId);
    if (!parent) continue;
    if (labelsOf(parent).includes(TLM_LABEL)) return parent;
    for (const grandparent of parentsOf.get(parent.id) ?? []) {
      if (!seen.has(grandparent)) { seen.add(grandparent); stack.push(grandparent); }
    }
  }
  return null;
}

// The Formatter/FormatterSpec ids of a document's DOC-WIDE stack: those reachable
// from `rootId` by hasPart WITHOUT descending into any DocumentSection. Walking the
// whole TLM subtree would sweep in sibling sections' per-section formatters too, so
// sections are walls — their own stacks belong to those sections, not the document.
function docWideFormatterIds(raw: RawGraphSnapshot, rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const e of raw.relationships) {
    if (e.type !== DOCUMENT_EDGE) continue;
    (childrenOf.get(e.start) ?? childrenOf.set(e.start, []).get(e.start)!).push(e.end);
  }

  const found = new Set<string>();
  const stack = [...(childrenOf.get(rootId) ?? [])];
  const seen = new Set<string>(stack);
  while (stack.length) {
    const nodeId = stack.pop()!;
    const node = raw.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    if (labelsOf(node).includes(SECTION_LABEL)) continue;   // wall: a sibling section's own subtree
    if (labelsOf(node).some((l) => FORMATTER_LABELS.has(l))) found.add(node.id);
    for (const child of childrenOf.get(node.id) ?? []) {
      if (!seen.has(child)) { seen.add(child); stack.push(child); }
    }
  }
  return found;
}

// The Formatter/FormatterSpec ids hung directly under one node (a section's own
// per-section stack), via hasPart.
function ownFormatterIds(raw: RawGraphSnapshot, rootId: string): Set<string> {
  const ids = descendants(raw, [rootId], new Set([DOCUMENT_EDGE]));
  ids.delete(rootId);
  return new Set([...ids].filter((id) => {
    const node = raw.nodes.find((n) => n.id === id);
    return node !== undefined && labelsOf(node).some((l) => FORMATTER_LABELS.has(l));
  }));
}

// The routine that applies to a section, resolved NEAREST-WINS along a
// document-first chain: the section's own usesRoutine, else the owning TLM's, else
// (compat with a spine-less Course) the nearest routine up the covered curriculum's
// ancestry. `resolvedFromScope` records which tier won. null when nothing in the
// chain uses a routine.
export type SectionRoutine = {
  entryId: string;                                     // the InstructionalRoutine the edge points at
  resolvedFrom: string;                                // the node that carried the usesRoutine edge
  resolvedFromScope: "section" | "document" | "curriculum";
  nodes: NodeOut[];                                    // the routine subtree (entry + its hasPart steps/materials)
  edges: EdgeOut[];
};

function resolveSectionRoutine(
  raw: RawGraphSnapshot,
  sectionId: string,
  tlmId: string | null,
  coversTargets: string[],
): SectionRoutine | null {
  const routineTargetOf = (nodeId: string): string | null =>
    raw.relationships.find((e) => e.type === ROUTINE_EDGE && e.start === nodeId)?.end ?? null;

  // The nearest-wins chain, document-first: section, then its TLM, then the covered
  // curriculum's ancestry (a covered lesson climbs to its Course-level routine).
  const chain: Array<{ id: string; scope: SectionRoutine["resolvedFromScope"] }> = [
    { id: sectionId, scope: "section" },
    ...(tlmId ? [{ id: tlmId, scope: "document" as const }] : []),
    ...ancestorsNearestFirst(raw, coversTargets).map((id) => ({ id, scope: "curriculum" as const })),
  ];

  for (const link of chain) {
    const entryId = routineTargetOf(link.id);
    if (entryId === null) continue;
    const routineIds = descendants(raw, [entryId], new Set([ROUTINE_EDGE_CONTENT]));
    const subtree = inducedSubgraph(raw, routineIds, new Set([ROUTINE_EDGE_CONTENT]));
    return { entryId, resolvedFrom: link.id, resolvedFromScope: link.scope, nodes: subtree.nodes, edges: subtree.edges };
  }
  return null;
}

// Everything a per-section generation composes: the section node, the owning
// document, the curriculum this slot renders, the applicable routine, and the
// formatters (doc-wide + this section's own).
export type DocumentSectionScope = {
  section: NodeOut;
  document: { id: string; assemblyGuide: string | null; node: NodeOut } | null;
  covers: string[];                                    // [] ⇒ front-matter (cover, TOC, intro)
  curriculum: { nodes: NodeOut[]; edges: EdgeOut[] };  // pure hasPart/hasChild from the covers targets
  routine: SectionRoutine | null;
  formatters: { nodes: NodeOut[]; edges: EdgeOut[] };  // the TLM's doc-wide stack ∪ this section's own
};

// The generation scope rooted at one DocumentSection. Returns null if `sectionId`
// is not a DocumentSection node in this graph.
export function documentSectionSubgraph(model: CurriculumModel, sectionId: string): DocumentSectionScope | null {
  const raw = model.rawGraph;
  if (!raw) return null;
  const section = raw.nodes.find((n) => n.id === sectionId);
  if (!section || !labelsOf(section).includes(SECTION_LABEL)) return null;

  // The document the section belongs to (nearest TLM up hasPart).
  const tlm = owningTlm(raw, sectionId);
  const document = tlm
    ? { id: tlm.id, assemblyGuide: assemblyGuideOf(tlm), node: nodeOut(tlm) }
    : null;

  // The curriculum this slot renders: the section's covers targets and their pure
  // containment subtree. An empty covers marks a front-matter section.
  const covers = raw.relationships.filter((e) => e.type === "covers" && e.start === sectionId).map((e) => e.end);
  const curriculumIds = descendants(raw, covers, CURRICULUM_EDGES);
  const curriculum = inducedSubgraph(raw, curriculumIds, CURRICULUM_EDGES);

  const routine = resolveSectionRoutine(raw, sectionId, tlm?.id ?? null, covers);

  // Formatters: this section's own per-section stack, unioned with the owning TLM's
  // doc-wide stack (sibling sections' stacks excluded).
  const formatterIds = new Set<string>([
    ...ownFormatterIds(raw, sectionId),
    ...(tlm ? docWideFormatterIds(raw, tlm.id) : []),
  ]);
  const formatters = inducedSubgraph(raw, formatterIds, new Set([DOCUMENT_EDGE]));

  return { section: nodeOut(section), document, covers, curriculum, routine, formatters };
}
