/*
 * Catalog — a library of reusable spec blocks (instructional routines and, later,
 * formatters) that a curator browses and copies onto content.
 *
 * The catalog lives in a reserved `_catalog` partition, ONE graph per SCOPE:
 *   - the cross-tenant SHARED library (workspace `_shared`), and
 *   - each workspace's own library (workspace = that tenant).
 * Both scopes share one shape — a three-level containment tree in canonical LC:
 *
 *   InstructionalRoutine (root container)          ← one per catalog graph, holds the entries
 *     ─hasPart→ InstructionalRoutine (ENTRY)       ← a catalog entry: "Fiche de leçon", …
 *                 ─hasPart→ InstructionalRoutine (step) ─hasPart→ Material
 *
 * Each entry carries a `kind` (routine | formatter). Using an entry COPIES it:
 * cloneRoutineSubtree mints fresh ids for the entry and its whole subtree into the
 * active subject's namespace, and `useRoutine` attaches the clone via `usesRoutine`.
 * The copy is independent — later edits to the library entry do NOT reach copies
 * already made (that independence is the point). Edit rights follow the entry's
 * namespace: `_shared` writes need super_admin, `<workspace>` writes its curators.
 *
 * See docs/design-notes/authorable-catalog.md.
 */

import { edgeId, kgNamespace, type GraphMutation, type MutationEdge, type MutationGraph, type MutationNode } from "../kg-store/index.js";
import type { RawGraphSnapshot } from "../types.js";

// The catalog namespace for a given scope. The third segment is historically
// "routines" (the catalog began routine-only); it now holds BOTH kinds, keyed by
// each entry's `kind`. Kept as-is so the already-seeded shared library isn't orphaned.
export const catalogNamespace = (workspace: string): string => kgNamespace(workspace, "_catalog", "routines");

// The reserved workspace that owns the cross-tenant shared library.
export const SHARED_CATALOG_WORKSPACE = "_shared";
export const SHARED_CATALOG_NAMESPACE = catalogNamespace(SHARED_CATALOG_WORKSPACE);

// The catalog's root container id — fixed so a re-seed overwrites the same node
// (deterministic, idempotent) rather than minting a second root.
export const CATALOG_ROOT_ID = "catalog-root";

const ROUTINE_LABEL = "InstructionalRoutine";
const MATERIAL_LABEL = "Material";
const CONTAINMENT = "hasPart";

// The labels a `usesRoutine` edge may originate from (canonical LC). A routine
// attaches to a Lesson; a formatter to the Course/deliverable — both are here.
const ROUTINE_USERS = new Set(["Lesson", "Course", "Activity"]);

export type CatalogScope = "shared" | "workspace";
export type CatalogKind = "routine" | "formatter";

// One catalog entry as listed to a browsing curator — the entry's identity, its
// kind, which scope it came from, plus a shallow outline (its steps) so the pick is
// informed without reading materials.
export type CatalogEntry = {
  id: string;
  kind: CatalogKind;
  scope: CatalogScope;          // which library this entry lives in (drives edit rights)
  name: string;                 // the entry's title (raw.description)
  summary: string;              // cross-cutting rules (raw.metadata.summary), "" when absent
  steps: Array<{ id: string; name: string; order: number; timeRequired?: string }>;
  materialCount: number;        // load-bearing Material leaves under the entry
};

const labelsOf = (n: MutationNode | undefined): string[] => n?.labels ?? [];
const isRoutine = (n: MutationNode | undefined): boolean => labelsOf(n).includes(ROUTINE_LABEL);
const isMaterial = (n: MutationNode | undefined): boolean => labelsOf(n).includes(MATERIAL_LABEL);
const rawOf = (n: MutationNode): Record<string, unknown> => (n.properties?.raw as Record<string, unknown>) ?? {};
const metaOf = (n: MutationNode): Record<string, unknown> => (rawOf(n).metadata as Record<string, unknown>) ?? {};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

// An entry's kind is tagged in metadata; entries with no tag are routines (the
// original kind, and how the already-seeded shared library reads).
const kindOf = (n: MutationNode): CatalogKind => (metaOf(n).catalogKind === "formatter" ? "formatter" : "routine");

// A step's ordinal comes from raw.position or raw.metadata.order (CI maths writes
// both); fall back to 0 so a malformed step still lists in a stable place.
const orderOf = (n: MutationNode): number => num(rawOf(n).position) ?? num(metaOf(n).order) ?? 0;

// Index the hasPart tree once: children[parent] = [childIds], and the set of nodes
// that are some routine's hasPart child (so a root is a routine that is nobody's).
function indexContainment(graph: MutationGraph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const hasRoutineParent = new Set<string>();
  for (const e of graph.edges) {
    if (e.type !== CONTAINMENT) continue;
    (children.get(e.from) ?? children.set(e.from, []).get(e.from)!).push(e.to);
    if (isRoutine(byId.get(e.from))) hasRoutineParent.add(e.to);
  }
  return { byId, children, hasRoutineParent };
}

// The entries a curator can pick: the root container's routine children. The root is
// the routine with no routine parent; its hasPart routine children are the entries,
// and each entry's routine children are its steps. A catalog with no root-container
// (e.g. loose routines) yields [] — the browse surface expects the container shape.
export function listCatalogEntries(graph: MutationGraph, scope: CatalogScope): CatalogEntry[] {
  const { byId, children, hasRoutineParent } = indexContainment(graph);
  const roots = graph.nodes.filter((n) => isRoutine(n) && !hasRoutineParent.has(n.id));

  const entries: CatalogEntry[] = [];
  for (const root of roots) {
    for (const entryId of children.get(root.id) ?? []) {
      const entry = byId.get(entryId);
      if (!entry || !isRoutine(entry)) continue;
      entries.push(describeEntry(entry, byId, children, scope));
    }
  }
  return entries;
}

function describeEntry(entry: MutationNode, byId: Map<string, MutationNode>, children: Map<string, string[]>, scope: CatalogScope): CatalogEntry {
  const steps: CatalogEntry["steps"] = [];
  let materialCount = 0;
  for (const childId of children.get(entry.id) ?? []) {
    const child = byId.get(childId);
    if (!child) continue;
    if (isRoutine(child)) {
      steps.push({ id: child.id, name: str(rawOf(child).description), order: orderOf(child), timeRequired: str(rawOf(child).timeRequired) || undefined });
      materialCount += (children.get(child.id) ?? []).filter((id) => isMaterial(byId.get(id))).length;
    } else if (isMaterial(child)) {
      materialCount += 1;
    }
  }
  steps.sort((a, b) => a.order - b.order);
  return {
    id: entry.id,
    kind: kindOf(entry),
    scope,
    name: str(rawOf(entry).description),
    summary: str(metaOf(entry).summary),
    steps,
    materialCount,
  };
}

// Everything reachable from an entry via hasPart (the entry, its steps, their
// Materials) — the subtree a copy carries.
function subtreeIds(entryId: string, children: Map<string, string[]>): string[] {
  const ids: string[] = [];
  const stack = [entryId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return ids;
}

export type ClonedSubtree = { nodes: MutationNode[]; edges: MutationEdge[]; newEntryId: string; idMap: Record<string, string> };

// Copy an entry's subtree into `namespace` with fresh ids. `mint(oldId)` supplies the
// new id for each node (the tool passes a stable map so dry-run and confirm agree).
// Returns the cloned nodes/edges (hasPart re-pointed to the new ids) and the new entry
// id the caller attaches a `usesRoutine` edge to. null when `entryId` isn't in the graph.
export function cloneRoutineSubtree(catalog: MutationGraph, entryId: string, namespace: string, mint: (oldId: string) => string): ClonedSubtree | null {
  const { byId, children } = indexContainment(catalog);
  if (!byId.has(entryId)) return null;

  const ids = subtreeIds(entryId, children);
  const idMap: Record<string, string> = {};
  for (const oldId of ids) idMap[oldId] = mint(oldId);

  const idSet = new Set(ids);
  const nodes: MutationNode[] = ids.map((oldId) => ({ ...(byId.get(oldId) as MutationNode), id: idMap[oldId], namespace, spine: false }));
  const edges: MutationEdge[] = catalog.edges
    .filter((e) => e.type === CONTAINMENT && idSet.has(e.from) && idSet.has(e.to))
    .map((e) => ({ id: edgeId(CONTAINMENT, idMap[e.from], idMap[e.to]), type: CONTAINMENT, from: idMap[e.from], to: idMap[e.to], namespace, properties: e.properties ?? {} }));

  return { nodes, edges, newEntryId: idMap[entryId], idMap };
}

// ── Authored formatter entries live in the seed tooling, not here ────────────
// The formatter house-style specs (the docx house style, the Senegalese art style, and
// the CI-maths pupil-manual illustration layout) are authored DATA, not server
// mechanism, so they live in `scripts/seed-catalog.mjs` and are fed to
// assembleCatalog(..., authored) at seed time — exactly like the subject bundles under
// sources/. This module keeps only the catalog machinery below (toCatalogStoreShape,
// rehomeEntries, assembleCatalog), plus the read/clone helpers above.

// ── Seeding the catalog ──────────────────────────────────────────────────────
// Convert a raw LC graph (as read from a source knowledge_graph.json — `start`/`end`
// edges, LC props at properties.*) into store shape for the catalog namespace: every
// node non-spine (type = its first label, props under properties.raw), namespaced to
// the catalog.
function toCatalogStoreShape(raw: RawGraphSnapshot, namespace: string): MutationGraph {
  const nodes: MutationNode[] = raw.nodes.map((n) => ({
    id: n.id, type: (n.labels ?? [])[0] ?? "", namespace,
    labels: n.labels ?? [], spine: false, properties: { raw: n.properties ?? {} },
  }));
  const edges: MutationEdge[] = raw.relationships.map((e) => ({
    id: edgeId(e.type, e.start, e.end), type: e.type, from: e.start, to: e.end,
    namespace, properties: e.properties ?? {},
  }));
  return { nodes, edges };
}

// Re-home one source's top-level routine subtrees under `rootId`, appending to
// `nodes`/`edges`. A top-level routine is an `InstructionalRoutine` with no routine
// `hasPart` parent; its subtree (steps + Materials) comes along verbatim, ids
// preserved. `keepFormatters` decides whether formatter-kind entries are taken —
// false for scraped subject bundles (a subject graph may CARRY formatter attachments,
// but those are copies of authored entries and must not be re-scraped into the catalog),
// true for the authored formatter literals that ARE the formatter entries.
function rehomeEntries(source: RawGraphSnapshot, namespace: string, rootId: string, keepFormatters: boolean, nodes: MutationNode[], edges: MutationEdge[]): void {
  const graph = toCatalogStoreShape(source, namespace);
  const { byId, children, hasRoutineParent } = indexContainment(graph);
  const entries = graph.nodes.filter((n) => isRoutine(n) && !hasRoutineParent.has(n.id) && (keepFormatters || kindOf(n) !== "formatter"));
  for (const entry of entries) {
    const ids = new Set(subtreeIds(entry.id, children));
    for (const id of ids) { const n = byId.get(id); if (n) nodes.push(n); }
    for (const e of graph.edges) if (e.type === CONTAINMENT && ids.has(e.from) && ids.has(e.to)) edges.push(e);
    edges.push({ id: edgeId(CONTAINMENT, rootId, entry.id), type: CONTAINMENT, from: rootId, to: entry.id, namespace, properties: {} });
  }
}

// Build a catalog's stored graph: a single root container plus re-homed entries.
// `sources` are subject graphs (a subject's knowledge_graph.json) — scraped for their
// ROUTINE subtrees only; any formatter a subject graph carries (a copy attached to its
// Course via use_formatter) is deliberately NOT re-scraped, since the catalog's
// formatters come solely from the authored literals in `authored`. `authored` are those
// formatter/routine literals, taken whole (formatters kept). Everything else in a source
// (chapters, lessons, the spine) is dropped. `namespace` is the target catalog.
export function assembleCatalog(sources: RawGraphSnapshot[], namespace = SHARED_CATALOG_NAMESPACE, rootId = CATALOG_ROOT_ID, authored: RawGraphSnapshot[] = []): MutationGraph {
  const root: MutationNode = {
    id: rootId, type: ROUTINE_LABEL, namespace, labels: [ROUTINE_LABEL], spine: false,
    properties: { raw: { description: "Routine library", metadata: { role: "instructional-routine" } } },
  };
  const nodes: MutationNode[] = [root];
  const edges: MutationEdge[] = [];

  for (const source of sources) rehomeEntries(source, namespace, rootId, false, nodes, edges);
  for (const source of authored) rehomeEntries(source, namespace, rootId, true, nodes, edges);
  return { nodes, edges };
}

// The mutation that lands a copied routine in the active subject's draft: it appends
// the pre-cloned subtree (built by cloneRoutineSubtree against the catalog namespace,
// passed in because apply() sees only the active base graph) and links the target
// lesson to the clone's entry via `usesRoutine`.
export type UseRoutineArgs = {
  namespace: string;
  targetId: string;             // the Lesson/Course/Activity that will use the routine
  clonedNodes: MutationNode[];
  clonedEdges: MutationEdge[];
  newEntryId: string;           // the cloned entry's id (a usesRoutine target)
};

const nodeById = (graph: MutationGraph, id: string) => graph.nodes.find((n) => n.id === id);

export const useRoutine: GraphMutation<UseRoutineArgs> = {
  name: "useRoutine",
  describe: (args) => `copy a catalog routine onto '${args.targetId}'`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    const target = nodeById(base, args.targetId);
    if (!target) errors.push(`use_routine: target '${args.targetId}' does not exist in the draft.`);
    else if (!(target.labels ?? []).some((l) => ROUTINE_USERS.has(l))) errors.push(`use_routine: '${args.targetId}' is a ${(target.labels ?? []).join("/") || "node"} — a routine attaches to a Lesson, Course, or Activity.`);
    if (!args.clonedNodes.some((n) => n.id === args.newEntryId)) errors.push(`use_routine: the cloned entry '${args.newEntryId}' is missing from the copied subtree (retry).`);
    for (const n of args.clonedNodes) if (nodeById(base, n.id)) errors.push(`use_routine: copied id '${n.id}' already exists in the draft (retry).`);
    return { errors, warnings: [] };
  },
  apply: (base, args) => {
    // apply() runs before validate() on the dry-run, so a bad target must return
    // base (→ clean "blocked" from validate) rather than produce a dangling edge.
    if (!nodeById(base, args.targetId)) return base;
    const link: MutationEdge = { id: edgeId("usesRoutine", args.targetId, args.newEntryId), type: "usesRoutine", from: args.targetId, to: args.newEntryId, namespace: args.namespace, properties: {} };
    return { nodes: [...base.nodes, ...args.clonedNodes], edges: [...base.edges, ...args.clonedEdges, link] };
  },
};
