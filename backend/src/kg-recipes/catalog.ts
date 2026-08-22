/*
 * Catalog — a library of reusable spec blocks (instructional routines, formatters
 * and evaluation rubrics) that a curator browses and copies onto content.
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
 * Each entry carries a `kind` (routine | formatter | rubric). Using an entry COPIES it:
 * cloneRoutineSubtree mints fresh ids for the entry and its whole subtree into the
 * active subject's namespace. A ROUTINE attaches to a Lesson via `usesRoutine`
 * (`useRoutine`); a FORMATTER is relabelled to the document-layer Formatter/
 * FormatterSpec shape (`relabelClonedFormatter`) and hung under the document's
 * TeachingLearningMaterial via `hasPart` (`useFormatter`) — formatting is a property
 * of the DOCUMENT, not the curriculum, so it never rides a Course's `usesRoutine`
 * edge (the pre-Phase-4 stopgap the TLM migration moved away from). A RUBRIC — the
 * evaluation grid a document is judged against — attaches the same way, relabelled to
 * Rubric/RubricSection/RubricCriterion (`useRubric`), because which grid governs a
 * document is a property of the document too. The copy is
 * independent — later edits to the library entry do NOT reach copies already made
 * (that independence is the point). Edit rights follow the entry's namespace:
 * `_shared` writes need super_admin, `<workspace>` writes its curators.
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

// The document-layer labels a formatter takes on when applied (Phase 4): the entry
// becomes a `Formatter`, its rule-bearing Material children `FormatterSpec`, and it
// hangs under a `TeachingLearningMaterial`. See docs/design-notes/teaching-learning-materials.md.
const FORMATTER_LABEL = "Formatter";
const FORMATTER_SPEC_LABEL = "FormatterSpec";
const TLM_LABEL = "TeachingLearningMaterial";

// The document-layer labels a RUBRIC takes on when applied — an evaluation grid
// (Annexe 8's approval checklist, Annexe 7's scored grid) hung under the document it
// judges. Three levels, because a grid is sections of criteria: Rubric ─hasPart→
// RubricSection ─hasPart→ RubricCriterion. Non-canonical, like the rest of the
// document layer. See docs/design-notes/evaluation-rubrics.md.
const RUBRIC_LABEL = "Rubric";
const RUBRIC_SECTION_LABEL = "RubricSection";
const RUBRIC_CRITERION_LABEL = "RubricCriterion";

// The labels a `usesRoutine` edge may originate from (canonical LC) — the valid
// targets of use_routine. A formatter no longer rides usesRoutine (it hangs under a
// TeachingLearningMaterial via hasPart — see useFormatter), so this is routines only.
const ROUTINE_USERS = new Set(["Lesson", "Course", "Activity"]);

export type CatalogScope = "shared" | "workspace";
export type CatalogKind = "routine" | "formatter" | "rubric";

// One catalog entry as listed to a browsing curator — the entry's identity, its
// kind, which scope it came from, plus a shallow outline (its steps) so the pick is
// informed without reading materials.
// One Material node under an entry: the id `edit_node` takes, plus its display name.
// These ids are surfaced HERE because a catalog cannot be traversed — walk_graph
// reads a parsed CurriculumModel and a catalog namespace has no subject profile to
// parse it with, so list_catalog / get_catalog_entry are the ONLY place a curator
// can learn which node holds a given spec's text.
export type CatalogMaterial = { id: string; name: string };

export type CatalogEntry = {
  id: string;
  kind: CatalogKind;
  scope: CatalogScope;          // which library this entry lives in (drives edit rights)
  name: string;                 // the entry's title (raw.description)
  summary: string;              // cross-cutting rules (raw.metadata.summary), "" when absent
  scale?: string;               // a RUBRIC's scoring scale, e.g. "0-4" or "oui-non"
  // A rubric's SECTIONS list here too — same shape as a routine's steps, with the
  // section's `weight` ("20%") in place of a step's `timeRequired`.
  steps: Array<{ id: string; name: string; order: number; timeRequired?: string; weight?: string; materials: CatalogMaterial[] }>;
  materials: CatalogMaterial[]; // the entry's OWN direct Materials — a formatter's spec
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
// original kind, and how the already-seeded shared library reads). Two tags mean
// formatter: `catalogKind:"formatter"` (how the seeded shared formatters are stamped)
// and `role:"formatter"` (how an author who built one via add_nodes tags it — there is
// no "Formatter" LC label to reach for, so the author overloads role). Either counts.
const kindOf = (n: MutationNode): CatalogKind => {
  const meta = metaOf(n);
  if (meta.catalogKind === "rubric") return "rubric";
  if (meta.catalogKind === "formatter" || meta.role === "formatter") return "formatter";
  return "routine";
};

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
  const materials: CatalogMaterial[] = [];
  let materialCount = 0;
  const kind = kindOf(entry);

  const asMaterial = (n: MutationNode): CatalogMaterial => ({ id: n.id, name: str(rawOf(n).description) });

  // The Material children directly under `parentId`. Empty for a FLAT step, whose
  // text lives on the step node itself — there, the step's own id is what edit_node
  // takes, so no separate material entry is needed.
  const materialsUnder = (parentId: string): CatalogMaterial[] =>
    (children.get(parentId) ?? [])
      .map((id) => byId.get(id))
      .filter((n): n is MutationNode => isMaterial(n))
      .map(asMaterial);

  const asStep = (n: MutationNode) => ({
    id: n.id,
    name: str(rawOf(n).description),
    order: orderOf(n),
    timeRequired: str(rawOf(n).timeRequired) || undefined,
    // Only a rubric SECTION carries a weight ("20%"); a routine step has none.
    weight: str(metaOf(n).weight) || undefined,
    materials: materialsUnder(n.id),
  });

  for (const childId of children.get(entry.id) ?? []) {
    const child = byId.get(childId);
    if (!child) continue;
    if (isRoutine(child)) {
      // Nested step shape: a step is a child routine, its body in a Material grandchild.
      steps.push(asStep(child));
      materialCount += materialsUnder(child.id).length;
    } else if (isMaterial(child)) {
      materialCount += 1;
      // Every direct Material is listed in `materials`, whatever the kind — a
      // formatter's spec lives ONLY here, and listing a routine's flat steps here
      // too keeps the field's meaning uniform ("the entry's own Materials") rather
      // than kind-dependent. Kind still decides what counts as a STEP.
      materials.push(asMaterial(child));
      // Flat step shape (add_nodes → add_to_catalog): a ROUTINE's direct Material child
      // IS a step (name/order/timing on the Material itself). A FORMATTER's direct
      // Materials are its spec, not steps.
      if (kind === "routine") steps.push(asStep(child));
    }
  }
  steps.sort((a, b) => a.order - b.order);
  return {
    id: entry.id,
    kind,
    scope,
    name: str(rawOf(entry).description),
    summary: str(metaOf(entry).summary),
    scale: str(metaOf(entry).scale) || undefined,
    steps,
    materials,
    materialCount,
  };
}

// One entry's FULL detail rendered as markdown, for the browse resource surface.
// Where listCatalogEntries gives a shallow outline (step names + a material count),
// this includes the load-bearing authored spec: a formatter's Material content, and
// each routine step's Material content. Returns null when the id isn't a routine
// entry in this graph.
export function renderCatalogEntry(graph: MutationGraph, entryId: string, scope: CatalogScope): string | null {
  const { byId, children } = indexContainment(graph);
  const entry = byId.get(entryId);
  if (!entry || !isRoutine(entry)) return null;

  const childrenOf = (id: string) => (children.get(id) ?? []).map((c) => byId.get(c)).filter((n): n is MutationNode => !!n);
  const kind = kindOf(entry);

  // Name the node each block of text lives on. Without this a reader who spots a
  // problem in the rendered spec has no way back to the node that holds it — a
  // catalog is not walkable, so this markdown is the only place the id appears
  // next to its content.
  const editHint = (id: string) => `\`edit_node\` nodeId: \`${id}\``;
  const lines: string[] = [`# ${str(rawOf(entry).description) || entryId}`, "", `*${kind} · ${scope} catalog*`, ""];
  const summary = str(metaOf(entry).summary);
  if (summary) lines.push(summary, "");

  if (kind === "formatter") {
    // A formatter's spec sits in its direct Material children — rendered flat, no headings.
    for (const m of childrenOf(entry.id).filter(isMaterial)) {
      const content = str(rawOf(m).content);
      if (content) lines.push(editHint(m.id), "", content, "");
    }
  } else if (kind === "rubric") {
    // A grid: weighted sections of named criteria. Unlike a routine step (whose text
    // IS the body), a criterion has BOTH a name ("Alignement aux objectifs") and a
    // measurable indicator, so the name gets its own heading above the indicator.
    const scale = str(metaOf(entry).scale);
    if (scale) lines.push(`**Échelle : ${scale}**`, "");
    const sections = childrenOf(entry.id).filter(isRoutine).sort((a, b) => orderOf(a) - orderOf(b));
    for (const section of sections) {
      const weight = str(metaOf(section).weight);
      lines.push(`## ${str(rawOf(section).description)}${weight ? `  (poids : ${weight})` : ""}`, "");
      for (const criterion of childrenOf(section.id).filter(isMaterial).sort((a, b) => orderOf(a) - orderOf(b))) {
        lines.push(`### ${str(rawOf(criterion).description)}`, "", editHint(criterion.id), "");
        const indicator = str(rawOf(criterion).content);
        if (indicator) lines.push(indicator, "");
      }
    }
  } else {
    // A routine's ordered steps, each under its own heading. A step is either a child
    // InstructionalRoutine (body in a Material grandchild) or a direct Material child
    // (body in its own content) — see describeEntry; both shapes render the same.
    const steps = childrenOf(entry.id).filter((c) => isRoutine(c) || isMaterial(c)).sort((a, b) => orderOf(a) - orderOf(b));
    for (const step of steps) {
      const timing = str(rawOf(step).timeRequired);
      lines.push(`## ${str(rawOf(step).description)}${timing ? `  (${timing})` : ""}`, "");
      // A flat step holds its own text, so the step node IS what edit_node takes; a
      // nested step's text sits in Material grandchildren, each with its own id.
      const bodies = isMaterial(step)
        ? [{ id: step.id, content: str(rawOf(step).content) }]
        : childrenOf(step.id).filter(isMaterial).map((m) => ({ id: m.id, content: str(rawOf(m).content) }));
      for (const body of bodies) {
        if (body.content) lines.push(editHint(body.id), "", body.content, "");
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
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
// preserved. `keepAuthoredKinds` decides whether NON-routine entries (formatters,
// rubrics) are taken — true for the authored literals that ARE those entries, false
// for scraped subject bundles: a subject graph CARRIES formatter/rubric attachments,
// but those are copies of authored entries and re-scraping them would seed a second
// copy of every one. (Copies applied since the document layer landed are relabelled
// to Formatter/Rubric and so fail `isRoutine` anyway; this guards the older ones that
// are still InstructionalRoutine with only a metadata tag.)
function rehomeEntries(source: RawGraphSnapshot, namespace: string, rootId: string, keepAuthoredKinds: boolean, nodes: MutationNode[], edges: MutationEdge[]): void {
  const graph = toCatalogStoreShape(source, namespace);
  const { byId, children, hasRoutineParent } = indexContainment(graph);
  const entries = graph.nodes.filter((n) => isRoutine(n) && !hasRoutineParent.has(n.id) && (keepAuthoredKinds || kindOf(n) === "routine"));
  for (const entry of entries) {
    const ids = new Set(subtreeIds(entry.id, children));
    for (const id of ids) { const n = byId.get(id); if (n) nodes.push(n); }
    for (const e of graph.edges) if (e.type === CONTAINMENT && ids.has(e.from) && ids.has(e.to)) edges.push(e);
    edges.push({ id: edgeId(CONTAINMENT, rootId, entry.id), type: CONTAINMENT, from: rootId, to: entry.id, namespace, properties: {} });
  }
}

// Build a catalog's stored graph: a single root container plus re-homed entries.
// `sources` are subject graphs (a subject's knowledge_graph.json) — scraped for their
// ROUTINE subtrees only; any formatter or rubric a subject graph carries (a copy
// attached under its document via use_formatter / use_rubric) is deliberately NOT
// re-scraped, since those come solely from the authored literals in `authored`.
// `authored` are the routine/formatter/rubric literals, taken whole (every kind kept).
// Everything else in a source (chapters, lessons, the spine) is dropped. `namespace`
// is the target catalog.
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

// ── use_formatter: copy a formatter under a document (TLM) ────────────────────
// The formatter counterpart to useRoutine. Where a routine is copied verbatim and
// linked to a Lesson via `usesRoutine`, a formatter is RELABELLED to the document
// layer and hung under a TeachingLearningMaterial via `hasPart` — the shape the
// Phase-4 migration produces (scripts/migrate-tlm-documents.mjs, Steps A + D), so a
// formatter applied today matches one migrated from the old usesRoutine stopgap.

// Drop the kind-signalling metadata tags a catalog entry carried (`catalogKind` /
// `role:"formatter"`) — once relabelled, the LC label carries the kind. Returns a
// fresh raw bag (metadata copied, not mutated) so the source catalog node is never
// touched; an emptied metadata bag is dropped so the relabelled node stays
// canonical-clean. A rubric's `weight` / `scale` survive: they are content, not tags.
// Mirrors migrate-tlm-documents.mjs::dropKindTags.
function withoutKindTags(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw };
  const metadata = next.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    const trimmed = { ...metadata };
    delete trimmed.catalogKind;
    delete trimmed.role;
    if (Object.keys(trimmed).length === 0) delete next.metadata;
    else next.metadata = trimmed;
  }
  return next;
}

// Turn a freshly-cloned formatter subtree into the document-layer shape a TLM holds:
// relabel the cloned entry → `Formatter` and its direct hasPart Material children →
// `FormatterSpec`, dropping each one's kind tags. Content is untouched. The clone's
// nodes are replaced with relabelled copies (properties copied, so the catalog source
// is never mutated); edges / idMap / newEntryId pass through unchanged. This mirrors
// the live-data migration's Step A relabel.
export function relabelClonedFormatter(clone: ClonedSubtree): ClonedSubtree {
  const specIds = new Set(
    clone.edges
      .filter((e) => e.type === CONTAINMENT && e.from === clone.newEntryId)
      .map((e) => e.to),
  );
  const nodes = clone.nodes.map((node) => {
    const isEntry = node.id === clone.newEntryId;
    const isSpec = specIds.has(node.id) && isMaterial(node);
    if (!isEntry && !isSpec) return node;
    const label = isEntry ? FORMATTER_LABEL : FORMATTER_SPEC_LABEL;
    return {
      ...node,
      type: label,
      labels: [label],
      properties: { ...(node.properties ?? {}), raw: withoutKindTags(rawOf(node)) },
    };
  });
  return { ...clone, nodes };
}

// The mutation that lands a copied FORMATTER under a document: it appends the
// pre-cloned + relabelled Formatter/FormatterSpec subtree (built by cloneRoutineSubtree
// then relabelClonedFormatter against the catalog, passed in because apply() sees only
// the active base graph) and links the target TeachingLearningMaterial to the clone's
// Formatter via `hasPart` — the document's rendering-stack axis. The write mirror of
// the migration's Step D (TLM ─hasPart→ Formatter, never Course ─usesRoutine→).
export type UseFormatterArgs = {
  namespace: string;
  tlmId: string;                // the TeachingLearningMaterial the formatter attaches under
  clonedNodes: MutationNode[];
  clonedEdges: MutationEdge[];
  newFormatterId: string;       // the cloned entry, relabelled to Formatter (the hasPart target)
};

// The checks use_formatter and use_rubric share: the target is an existing
// TeachingLearningMaterial, and the pre-built clone is intact and not already in the
// draft. `tool`/`noun` name the caller so the message reads as that tool's own, e.g.
// ("use_rubric", "rubric").
function validateDocumentAttachment(
  base: MutationGraph,
  args: { tlmId: string; clonedNodes: MutationNode[] },
  attachedId: string,
  tool: string,
  noun: string,
): string[] {
  const errors: string[] = [];
  const target = nodeById(base, args.tlmId);
  if (!target) {
    errors.push(`${tool}: document '${args.tlmId}' does not exist in the draft.`);
  } else if (!(target.labels ?? []).includes(TLM_LABEL)) {
    const labels = (target.labels ?? []).join("/") || "node";
    errors.push(`${tool}: '${args.tlmId}' is a ${labels} — a ${noun} attaches under a ${TLM_LABEL} (the document). Pass a TLM id, or a Course to resolve its TLM.`);
  }
  if (!args.clonedNodes.some((n) => n.id === attachedId)) {
    errors.push(`${tool}: the cloned ${noun} '${attachedId}' is missing from the copied subtree (retry).`);
  }
  for (const node of args.clonedNodes) {
    if (nodeById(base, node.id)) errors.push(`${tool}: copied id '${node.id}' already exists in the draft (retry).`);
  }
  return errors;
}

// Append the cloned subtree and hang its root under the document via `hasPart`.
// apply() runs before validate() on the dry-run, so a missing document must return
// base (→ a clean "blocked" from validate) rather than produce a dangling edge.
function attachUnderDocument(
  base: MutationGraph,
  args: { namespace: string; tlmId: string; clonedNodes: MutationNode[]; clonedEdges: MutationEdge[] },
  attachedId: string,
): MutationGraph {
  if (!nodeById(base, args.tlmId)) return base;
  const link: MutationEdge = {
    id: edgeId(CONTAINMENT, args.tlmId, attachedId),
    type: CONTAINMENT, from: args.tlmId, to: attachedId,
    namespace: args.namespace, properties: {},
  };
  return { nodes: [...base.nodes, ...args.clonedNodes], edges: [...base.edges, ...args.clonedEdges, link] };
}

export const useFormatter: GraphMutation<UseFormatterArgs> = {
  name: "useFormatter",
  describe: (args) => `copy a catalog formatter under document '${args.tlmId}'`,
  validate: (base, _after, args) => ({ errors: validateDocumentAttachment(base, args, args.newFormatterId, "use_formatter", "formatter"), warnings: [] }),
  apply: (base, args) => attachUnderDocument(base, args, args.newFormatterId),
};

// ── use_rubric: copy an evaluation grid under a document (TLM) ────────────────
// The third apply verb, alongside useRoutine (→ a Lesson) and useFormatter (→ a
// document). A RUBRIC is the grid a document is judged against — Annexe 8's approval
// checklist, Annexe 7's scored grid — so it attaches where a formatter does, under the
// TeachingLearningMaterial via `hasPart`: both are properties of the DOCUMENT, not of
// the curriculum. Attaching it is what makes "which grid governs this document"
// graph data instead of convention, and it is what evaluate_document reads.

// Turn a freshly-cloned rubric subtree into the document-layer shape: the entry →
// `Rubric`, its section children → `RubricSection`, their Material leaves →
// `RubricCriterion`, each with its catalog kind tags dropped. Content, weights and
// scale are untouched. Mirrors relabelClonedFormatter, one level deeper.
export function relabelClonedRubric(clone: ClonedSubtree): ClonedSubtree {
  const childIdsOf = (parentId: string): string[] =>
    clone.edges.filter((e) => e.type === CONTAINMENT && e.from === parentId).map((e) => e.to);

  const sectionIds = new Set(childIdsOf(clone.newEntryId));
  const criterionIds = new Set<string>();
  for (const sectionId of sectionIds) {
    for (const criterionId of childIdsOf(sectionId)) criterionIds.add(criterionId);
  }

  // null = leave this node alone (anything deeper than criteria, or a stray non-Material).
  const labelFor = (node: MutationNode): string | null => {
    if (node.id === clone.newEntryId) return RUBRIC_LABEL;
    if (sectionIds.has(node.id)) return RUBRIC_SECTION_LABEL;
    if (criterionIds.has(node.id) && isMaterial(node)) return RUBRIC_CRITERION_LABEL;
    return null;
  };

  const nodes = clone.nodes.map((node) => {
    const label = labelFor(node);
    if (!label) return node;
    return {
      ...node,
      type: label,
      labels: [label],
      properties: { ...(node.properties ?? {}), raw: withoutKindTags(rawOf(node)) },
    };
  });
  return { ...clone, nodes };
}

export type UseRubricArgs = {
  namespace: string;
  tlmId: string;                // the TeachingLearningMaterial the rubric judges
  clonedNodes: MutationNode[];
  clonedEdges: MutationEdge[];
  newRubricId: string;          // the cloned entry, relabelled to Rubric (the hasPart target)
};

export const useRubric: GraphMutation<UseRubricArgs> = {
  name: "useRubric",
  describe: (args) => `copy a catalog rubric under document '${args.tlmId}'`,
  validate: (base, _after, args) => ({ errors: validateDocumentAttachment(base, args, args.newRubricId, "use_rubric", "rubric"), warnings: [] }),
  apply: (base, args) => attachUnderDocument(base, args, args.newRubricId),
};

// ── add_to_catalog: publish an authored entry INTO a catalog ─────────────────
// The inverse of useRoutine. useRoutine copies a library entry OUT onto a lesson;
// this copies an entry IN — a routine/formatter subtree authored in a subject
// graph, cloned (fresh ids, via cloneRoutineSubtree) into a catalog namespace and
// filed under that library's root container by `hasPart`, so list_catalog/use_*
// then surface it. The subtree is cloned by the tool (apply() sees only the target
// catalog's base), exactly as useRoutine takes its clone pre-built.

// The catalog's root container in `graph`: the fixed CATALOG_ROOT_ID when present
// (how every seeded library is built), else the routine that is nobody's hasPart
// child. null for a catalog with no container — the caller reports "seed first".
export function catalogRootId(graph: MutationGraph): string | null {
  if (graph.nodes.some((n) => n.id === CATALOG_ROOT_ID)) return CATALOG_ROOT_ID;
  const { hasRoutineParent } = indexContainment(graph);
  return graph.nodes.find((n) => isRoutine(n) && !hasRoutineParent.has(n.id))?.id ?? null;
}

export type AddCatalogEntryArgs = {
  namespace: string;            // the CATALOG namespace being written
  clonedNodes: MutationNode[];  // the entry subtree, fresh ids, already namespaced to the catalog
  clonedEdges: MutationEdge[];
  newEntryId: string;           // the cloned entry's id (filed under the catalog root)
};

export const addCatalogEntry: GraphMutation<AddCatalogEntryArgs> = {
  name: "addCatalogEntry",
  describe: (args) => `add a catalog entry (${args.newEntryId}) to library '${args.namespace}'`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (!catalogRootId(base)) errors.push(`add_to_catalog: '${args.namespace}' has no catalog root container to file under — seed the catalog first.`);
    if (!args.clonedNodes.some((n) => n.id === args.newEntryId)) errors.push(`add_to_catalog: the cloned entry '${args.newEntryId}' is missing from the copied subtree (retry).`);
    for (const n of args.clonedNodes) if (nodeById(base, n.id)) errors.push(`add_to_catalog: copied id '${n.id}' already exists in the catalog (retry).`);
    return { errors, warnings: [] };
  },
  apply: (base, args) => {
    const rootId = catalogRootId(base);
    if (!rootId) return base; // no container → clean "blocked" from validate
    const link: MutationEdge = { id: edgeId(CONTAINMENT, rootId, args.newEntryId), type: CONTAINMENT, from: rootId, to: args.newEntryId, namespace: args.namespace, properties: {} };
    return { nodes: [...base.nodes, ...args.clonedNodes], edges: [...base.edges, ...args.clonedEdges, link] };
  },
};
