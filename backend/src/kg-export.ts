/*
 * Layer: app · read-only KG export
 *
 * Backs the live KG explorer (a hosted static page). Reads the PUBLISHED slot of
 * the generic node/edge store and transforms it into the "display schema" the
 * explorer's views + modal consume. READ-ONLY and published-only: it resolves
 * the pointer's publishedSlot and never touches drafts, so a curator's in-flight
 * edit never leaks here until they publish.
 *
 * This is purely additive — it reuses the same store the MCP read/curator tools
 * use (getKgStore + readPointer/listNodes/listEdges), and reuses the same
 * namespace enumeration (listAvailableContexts × a published pointer). It does
 * NOT go through the subject adapters' presenter layer (the cooked slice in
 * get_generation_context), because the explorer needs the WHOLE spine graph
 * (every node + edge), not a per-unit slice. It reads the same normalized store
 * those adapters hydrate from.
 *
 * Data-scope note (see docs/design-notes/kg-explorer-findings.md): the store now holds the
 * FULL Learning-Commons graph — the curriculum spine (for CI maths
 * `domaine → chapter → lesson → component → task` via hasChild, plus
 * `chapter → chapter` buildsTowards; for CE1 reading `week → standard →
 * component`) AND the framework/derived nodes + supports/relatesTo cross-links
 * that used to be dropped at ingest. The explorer surfaces all of it: spine
 * nodes keep their category, non-spine nodes fall into the neutral `framework`
 * legend bucket, and every edge type renders.
 */
import { getKgStore, kgNamespace, parseNamespace } from "./kg-store/index.js";
import type { StoredNode, StoredEdge, MutationGraph, MutationNode, MutationEdge } from "./kg-store/index.js";
import {
  SHARED_CATALOG_NAMESPACE, catalogNamespace, listCatalogEntries, renderCatalogEntry,
  type CatalogEntry, type CatalogScope,
} from "./kg-recipes/index.js";
import { listAvailableContexts } from "./context/index.js";

// ── Display schema (what the explorer consumes) ──────────────────────────────
// The React explorer (frontend/explorer/, schema mirrored in
// frontend/explorer/src/types.ts) consumes these node fields directly;
// edges use {s,t,r} + an order hint `o`.
export type DisplayNode = {
  id: string;
  label: string;                 // Learning-Commons ontology label — the node's identity
  kind: string;                  // = label (the explorer speaks LC labels only)
  cat: string;                   // = label (legend category → drives colour/legend/stats)
  code: string;                  // identifier / statement_code
  ord: number | null;            // metadata.order (stable sort within a parent)
  desc: string; desc_en: string; // display text (bilingual)
  nt: string;                    // LC sub-type hint (normalized_type / normalized_statement_type)
  st: string; st_en: string;     // LC statement_type (category detail), bilingual
  srcKey: string;                // provenance (source_key) → source-filter chips
  props: Record<string, unknown>;// the node's raw LC properties, for the detail panel
};

// ── Legend taxonomy — by Learning-Commons LABEL ──────────────────────────────
// The explorer follows the LC ontology ONLY: a node's legend category is its LC
// top-level label (no subject roles like chapter/week/strand). `meta.taxonomy`
// lists, in this canonical order, only the labels actually present, each with a
// bilingual name + colour.
export type TaxonomyEntry = { key: string; label: { fr: string; en: string }; color: string };

// One colour per LC label (palette kept in sync with frontend/explorer's theme).
// Canonical LC labels, in containment order (Course → grouping → lesson →
// activity → material), with the standards labels first and LearningComponent last.
const LABEL_DEFS: TaxonomyEntry[] = [
  { key: "StandardsFramework",     label: { fr: "Cadre de référence", en: "Standards framework" }, color: "#5b8def" },
  { key: "StandardsFrameworkItem", label: { fr: "Élément du cadre",   en: "Framework item" },      color: "#378add" },
  { key: "Course",                 label: { fr: "Cours",              en: "Course" },               color: "#b5651d" },
  { key: "LessonGrouping",         label: { fr: "Regroupement",       en: "Lesson grouping" },      color: "#7f77dd" },
  { key: "Lesson",                 label: { fr: "Leçon",              en: "Lesson" },               color: "#1d9e75" },
  { key: "Activity",               label: { fr: "Activité",           en: "Activity" },             color: "#c98a1a" },
  { key: "Material",               label: { fr: "Matériel",           en: "Material" },             color: "#888780" },
  { key: "LearningComponent",      label: { fr: "Composant",          en: "Learning component" },   color: "#d4537e" },
  // The non-canonical document / rendering layer (teaching-learning-materials.md):
  // a teal family for the document nodes (TLM ▸ DocumentSection), a plum family for
  // the rendering nodes (Formatter ▸ FormatterSpec) — kept clearly apart from the
  // curriculum hues above so a Documents view reads as its own layer.
  { key: "TeachingLearningMaterial", label: { fr: "Document",         en: "Document (TLM)" },        color: "#0e7c86" },
  { key: "DocumentSection",          label: { fr: "Section",          en: "Document section" },      color: "#3ba7a0" },
  { key: "Formatter",                label: { fr: "Formateur",        en: "Formatter" },             color: "#6d597a" },
  { key: "FormatterSpec",            label: { fr: "Règle de format",  en: "Formatter spec" },        color: "#9b8aa8" },
];

// `r` is the TRAVERSAL type (what the containment tree walks — always "hasChild"
// for folded edges), while `rel` is the REAL LC edge type for the badge, so the UI
// can tell a genuine hasChild from a folded supports/hasEducationalAlignment/hasPart
// (or a metadata-derived "illustrates"). Keeping them separate is what makes the
// tree walkable AND the badges honest.
export type DisplayEdge = { s: string; t: string; r: string; rel: string; o: number };

export type GroupByLevel = { key: keyof DisplayNode | string; labelFr?: string; labelEn?: string };
export type ViewSpec =
  | {
      id: string; label: { fr: string; en: string }; shape: "grouped-spine";
      params: { anchorKind: string; groupBy: GroupByLevel[]; expandEdge: string; stopKind?: string | null; order?: string[] };
    }
  // A containment tree filtered to a set of LC labels: roots are included nodes
  // with no included parent, children are `expandEdge` targets whose label is in
  // `includeLabels`. `rootKinds` (optional) restricts which labels may be a root —
  // needed for Curriculum, where illustrative Activities are re-parented under
  // components (excluded here) and would otherwise float up as orphan roots.
  // `pruneToLabel` hides any branch with no descendant of that label (so the
  // Learning-components view shows only decomposed standards).
  // `reverse` walks `expandEdge` bottom-up (target→source), so the tree flows from
  // the leaf outward — the Learning-components view reads LearningComponent →
  // (supports) → framework item → framework, not the framework down.
  // `alignmentTail` grafts extra branches onto content leaves that the plain
  // containment walk folds away: an ordered chain of steps, each expanding a node
  // of LC label `from` along a REAL edge type `rel` (`dir:"in"` follows it toward
  // the node, `"out"` away from it). Curriculum uses it to let a Lesson walk out to
  // the standard it aligns with, then to that standard's supporting components.
  | {
      id: string; label: { fr: string; en: string }; shape: "label-tree";
      params: {
        includeLabels: string[]; expandEdge: string; rootKinds?: string[]; pruneToLabel?: string; reverse?: boolean;
        alignmentTail?: Array<{ from: string; rel: string; dir: "in" | "out" }>;
      };
    }
  // Learning progression: prereq → successor chains over one edge type. Roots are
  // nodes with an outgoing `edge` and no incoming one (chain starts).
  | { id: string; label: { fr: string; en: string }; shape: "progression"; params: { edge: string } }
  | { id: string; label: { fr: string; en: string }; shape: "node-type"; params?: Record<string, never> };

export type ViewConfig = { views: ViewSpec[] };

export type DisplayGraph = {
  nodes: DisplayNode[];
  edges: DisplayEdge[];
  meta: {
    ns: string;
    label: { fr: string; en: string };
    publishedSlot: string;
    counts: { nodes: number; edges: number; byKind: Record<string, number> };
    sources: string[];           // distinct srcKeys present → source-filter chips
    taxonomy: TaxonomyEntry[];   // graph-agnostic legend categories present, in canonical order
    viewConfig: ViewConfig;
    generatedAt: string;
    note: string;                // human note: published-only, spine-scope
  };
};

// ── Namespace labels ─────────────────────────────────────────────────────────
// A KG appears in the selector automatically once it has an installed source
// folder AND a published pointer. The pretty label is looked up by grade/subject
// (so it survives an env bucket-prefix), with a plain fallback.
const SUBJECT_LABELS: Record<string, { fr: string; en: string }> = {
  maths: { fr: "Mathématiques", en: "Mathematics" },
  reading: { fr: "Lecture", en: "Reading" },
};
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function nsLabel(grade: string, subject: string): { fr: string; en: string } {
  const subj = SUBJECT_LABELS[subject] ?? { fr: cap(subject), en: cap(subject) };
  const g = grade.toUpperCase();
  return { fr: `${subj.fr} — ${g}`, en: `${subj.en} — ${g}` };
}

// ── Enumerate available namespaces (only those with a published pointer) ──────
export async function listExportNamespaces(): Promise<
  Array<{ ns: string; workspace: string; grade: string; subject: string; label: { fr: string; en: string } }>
> {
  const store = getKgStore();
  const out: Array<{ ns: string; workspace: string; grade: string; subject: string; label: { fr: string; en: string } }> = [];
  for (const { workspace, grade, subject } of listAvailableContexts()) {
    const ns = kgNamespace(workspace, grade, subject);
    const pointer = await store.readPointer(ns).catch(() => null);
    if (!pointer) continue; // never seeded → not selectable
    out.push({ ns, workspace, grade, subject, label: nsLabel(grade, subject) });
  }
  return out;
}

// ── raw-LC → display node transform ──────────────────────────────────────────
// Maps a stored node ({type, properties:{code,title,text,order,isAssessment,raw}})
// to the explorer's display node. Reads raw.* with both CI CI maths (camelCase) and
// CE1 CE1 reading (snake_case) spellings where they differ, so ONE mapping serves both.
const LABEL_BY_KIND: Record<string, string> = {
  domaine: "StandardsFrameworkItem",
  chapter: "StandardsFrameworkItem",
  lesson: "StandardsFrameworkItem",
  standard: "StandardsFrameworkItem",
  week: "StandardsFrameworkItem",
  component: "LearningComponent",
  task: "Activity",
};

const str = (v: unknown): string => (v == null ? "" : String(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const numOrStr = (v: unknown): number | string => (typeof v === "number" ? v : v == null ? "" : String(v));

function toDisplayNode(n: StoredNode): DisplayNode {
  const p = n.properties ?? {};
  const raw = (p.raw as Record<string, unknown>) ?? {};
  const r = (k: string) => raw[k];
  const m = (raw.metadata as Record<string, unknown>) ?? {};
  const en = (k: string) => ((m.en as Record<string, unknown>) ?? {})[k];
  const label = (n.labels && n.labels[0]) || LABEL_BY_KIND[n.type] || n.type;
  return {
    id: n.id,
    label,
    kind: label,   // LC-only: the explorer keys on the label, not the subject kind
    cat: label,
    code: str(p.code ?? r("statementCode") ?? r("identifier")),
    ord: typeof p.order === "number" ? (p.order as number) : (typeof m.order === "number" ? (m.order as number) : null),
    desc: str(p.text ?? p.title ?? r("description") ?? r("osTexte")),
    desc_en: str(en("description") ?? en("os_texte")),
    nt: str(r("normalizedType") ?? r("normalizedStatementType") ?? r("contentType")),
    st: str(r("statementType")),
    st_en: str(en("statement_type")),
    srcKey: str(r("sourceKey")),
    // The whole raw LC property bag — the detail panel renders it generically, so
    // no field is subject-specific here. `metadata` is flattened one level for
    // readability (role/order/palier/genre/… become top-level keys).
    props: flattenProps(raw),
  };
}

// Flatten `raw` for the detail panel: keep scalar/array props, lift `metadata.*`
// (minus the bulky `en` translations) to the top level, and drop the `raw`-nested
// `metadata`/`en` containers so the panel shows a clean key/value list.
function flattenProps(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "metadata") continue;
    out[k] = v;
  }
  const m = (raw.metadata as Record<string, unknown>) ?? {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "en") continue;
    out[k] = v;
  }
  return out;
}

function edgeOrder(e: StoredEdge): number {
  const p = e.properties ?? {};
  return typeof p.orderInParent === "number" ? (p.orderInParent as number)
    : typeof p.sequenceInFrom === "number" ? (p.sequenceInFrom as number)
    : typeof e.seq === "number" ? e.seq             // supports/relatesTo carry no order prop → fall back to raw sequence
    : 0;
}

// Context for the fold: which activities illustrate which component (a metadata
// link — canonical LC has NO Activity↔LearningComponent edge — see CLAUDE.md), and
// whether a given node id is present.
type FoldContext = { illustrates: Map<string, { comp: string; order: number }>; has: (id: string) => boolean };

// One stored edge → its DISPLAY edge(s). The containment tree walks a single
// TRAVERSAL type (`r: "hasChild"`), so we normalise canonical LC's edges onto it,
// but each display edge also carries its REAL type in `rel` for an honest badge
// (display-only — the store keeps the real edges):
//   • `hasPart` (content containment) → forward; rel "hasPart".
//   • `supports` (component→SFI) and `hasEducationalAlignment` (lesson/activity→SFI)
//     are alignment/part-of the standard: fold REVERSED (parent = the supported
//     end) so components/lessons stay reachable; rel = the real edge type.
//   • An illustrative `Activity` (hasEducationalAlignment to its standard) is
//     RE-PARENTED under the LearningComponent it exemplifies — the nesting the LC
//     graph can't express as an edge — via metadata.illustratesComponent; rel
//     "illustrates". Falls back to the standard fold if that component is absent.
//   • That same activity is ALSO held directly by its derived frame via a real
//     hasChild; we DROP that display edge (only when the component resolves, so the
//     illustrates fold already gave it a parent) so it nests under the component
//     alone instead of also hanging off the frame.
//   • `usesRoutine` (Course/Lesson/Activity → InstructionalRoutine) folds forward to
//     the tree so the shared routine nests under EVERY node that uses it — the guide
//     Course and each of its lessons — each showing a collapsed routine child with an
//     honest `usesRoutine` badge (rel). The real edges are unchanged in the store.
//   • hasChild / buildsTowards / relatesTo otherwise pass through with their own type.
function toDisplayEdges(e: StoredEdge, ctx: FoldContext): DisplayEdge[] {
  if (e.type === "usesRoutine") {
    return [{ s: e.from, t: e.to, r: "hasChild", rel: "usesRoutine", o: edgeOrder(e) }];
  }
  // `covers` (document → curriculum, teaching-learning-materials.md) is NOT
  // containment — keep it on its OWN traversal axis (r "covers") so it never folds
  // into the hasChild tree the curriculum views walk. The Documents view reaches
  // the covered Course/Lesson through this edge as a display-only link out.
  if (e.type === "covers") {
    return [{ s: e.from, t: e.to, r: "covers", rel: "covers", o: edgeOrder(e) }];
  }
  if (e.type === "supports" || e.type === "hasEducationalAlignment") {
    if (e.type === "hasEducationalAlignment") {
      const ill = ctx.illustrates.get(e.from);
      if (ill && ctx.has(ill.comp)) return [{ s: ill.comp, t: e.from, r: "hasChild", rel: "illustrates", o: ill.order }];
    }
    return [{ s: e.to, t: e.from, r: "hasChild", rel: e.type, o: edgeOrder(e) }];
  }
  if (e.type === "hasPart") return [{ s: e.from, t: e.to, r: "hasChild", rel: "hasPart", o: edgeOrder(e) }];
  if (e.type === "hasDependency") {
    // Canonical LC content prerequisite: `dependent hasDependency prereq`. Normalise
    // to the progression direction `prereq buildsTowards dependent` (reversed) so the
    // Learning-progression view reads prereq → successor uniformly, whatever the
    // source dialect used (mirrors the parser's hasDependency handling).
    return [{ s: e.to, t: e.from, r: "buildsTowards", rel: "buildsTowards", o: edgeOrder(e) }];
  }
  if (e.type === "hasChild") {
    const ill = ctx.illustrates.get(e.to);       // frame → illustrative activity: drop (it nests under its component)
    if (ill && ctx.has(ill.comp)) return [];
  }
  return [{ s: e.from, t: e.to, r: e.type, rel: e.type, o: edgeOrder(e) }];
}

// ── viewConfig — Learning-Commons ontology views ONLY ────────────────────────
// The four LC lenses (https://docs.learningcommons.org — core concepts), each
// emitted only when the namespace actually holds that layer's data, plus a
// generic catch-all. No subject vocabulary (no domaine/week/strand/palier).
//   1. STANDARDS      — the full containment tree (the former "Hierarchy"):
//      anchored on the framework root and expanded via hasChild, so
//      LearningComponents (supports, folded) and the curriculum content (hasPart /
//      hasEducationalAlignment, folded) all nest in with honest rel badges. The
//      other tabs below are focused lenses over the same graph.
//   2. LEARNING COMPONENTS — flows outward from each LearningComponent: LC →
//      (supports) framework item → framework, reversing the folded hasChild tree.
//   3. CURRICULUM     — the content layer Course → LessonGrouping → Lesson →
//      Activity → Material (hasPart), anchored on the top content nodes.
//   4. LEARNING PROGRESSION — prereq → successor chains over buildsTowards
//      (hasDependency is normalised onto it in toDisplayEdges).
//   5. BY-TYPE        — the generic node-type floor: every node grouped by its LC
//      label, each showing its outgoing relations. Works for any namespace.
const STANDARDS_LABELS = ["StandardsFramework", "StandardsFrameworkItem"];
// InstructionalRoutine + Material carry the shared "fiche de leçon" routine; it folds
// into the content tree under the Course only (see toDisplayEdges' usesRoutine case).
const CONTENT_LABELS = ["Course", "LessonGrouping", "Lesson", "Activity", "Material", "InstructionalRoutine"];
// The document / rendering layer, nested by hasPart (folded onto the hasChild
// display axis): TLM ▸ DocumentSection · TLM ▸ Formatter ▸ FormatterSpec.
const DOCUMENT_LABELS = ["TeachingLearningMaterial", "DocumentSection", "Formatter", "FormatterSpec"];

function buildViewConfig(nodes: DisplayNode[], edges: DisplayEdge[]): ViewConfig {
  const present = new Set(nodes.map((n) => n.label));
  const has = (l: string) => present.has(l);
  const views: ViewSpec[] = [];

  if (has("StandardsFramework")) {
    views.push({
      id: "standards", label: { fr: "Standards", en: "Standards" }, shape: "grouped-spine",
      params: { anchorKind: "StandardsFramework", groupBy: [], expandEdge: "hasChild" },
    });
  }
  if (has("LearningComponent")) {
    views.push({
      id: "components", label: { fr: "Composants d'apprentissage", en: "Learning components" }, shape: "label-tree",
      // Flows FROM the LearningComponent outward: LC → (supports) → framework item →
      // framework. We reverse the same hasChild tree (which already folds `supports`
      // reversed), so each component heads its own branch up to the framework root.
      // Roots are the LearningComponents only (rootKinds), so a framework item with
      // no supporting component never floats up as an orphan root.
      params: { includeLabels: [...STANDARDS_LABELS, "LearningComponent"], expandEdge: "hasChild", rootKinds: ["LearningComponent"], reverse: true },
    });
  }
  if (CONTENT_LABELS.some(has)) {
    views.push({
      id: "curriculum", label: { fr: "Curriculum", en: "Curriculum" }, shape: "label-tree",
      // Only Course / top LessonGrouping anchor the content tree; Lesson/Activity/
      // Material never head it (illustrative Activities are exemplars under
      // components and must not surface here as orphans).
      // The tail lets a Lesson walk out to the standard it teaches
      // (hasEducationalAlignment) and, under that standard, the learning components
      // that support it (supports) — the alignment the content walk folds away.
      params: {
        includeLabels: CONTENT_LABELS, expandEdge: "hasChild", rootKinds: ["Course", "LessonGrouping"],
        alignmentTail: [
          { from: "Lesson", rel: "hasEducationalAlignment", dir: "in" },
          { from: "StandardsFrameworkItem", rel: "supports", dir: "out" },
        ],
      },
    });
  }
  if (edges.some((e) => e.rel === "buildsTowards")) {
    views.push({ id: "progression", label: { fr: "Progression", en: "Learning progression" }, shape: "progression", params: { edge: "buildsTowards" } });
  }
  if (has("TeachingLearningMaterial")) {
    views.push({
      id: "documents", label: { fr: "Documents", en: "Documents" }, shape: "label-tree",
      // Rooted on the TLM (rootKinds), walking its hasPart nesting (folded onto
      // hasChild) down through DocumentSection / Formatter / FormatterSpec. The tail
      // grafts each covered curriculum node — a TLM's Course, a section's Lesson —
      // as a display-only leaf out to the curriculum (dir "out" over the real
      // `covers` edge), the same way the Curriculum view reveals a lesson's standard.
      params: {
        includeLabels: DOCUMENT_LABELS, expandEdge: "hasChild", rootKinds: ["TeachingLearningMaterial"],
        alignmentTail: [
          { from: "TeachingLearningMaterial", rel: "covers", dir: "out" },
          { from: "DocumentSection", rel: "covers", dir: "out" },
        ],
      },
    });
  }
  views.push({ id: "generic", label: { fr: "Par type (LC)", en: "By type (LC)" }, shape: "node-type" });
  return { views };
}

// ── Shared projection: stored graph → display nodes/edges/meta ────────────────
// Extracted so the full-namespace export and the scoped-subtree export project
// the graph through the SAME transforms — the folding, taxonomy, and viewConfig
// stay identical whichever slice a caller asks for.

// Fold every stored edge to its display edge(s), threading the illustrates map
// (activity → component it exemplifies) the fold needs to nest illustrative
// activities under their component instead of beside their siblings.
function projectDisplayEdges(nodes: DisplayNode[], storedEdges: StoredEdge[]): DisplayEdge[] {
  const illustrates = new Map<string, { comp: string; order: number }>();
  for (const n of nodes) {
    const ic = n.props?.illustratesComponent as { id?: string; order?: number } | undefined;
    if (ic?.id) illustrates.set(n.id, { comp: ic.id, order: typeof ic.order === "number" ? ic.order : 0 });
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  return storedEdges.flatMap((e) => toDisplayEdges(e, { illustrates, has: (id) => nodeIds.has(id) }));
}

// Wrap a set of already-projected display nodes/edges in the meta envelope the
// explorer consumes: per-label counts, source chips, the present-labels legend
// taxonomy, and the derived viewConfig. `note` describes the slice (full graph
// vs. scoped subtree). Colouring/legend/views all reflect ONLY what is present,
// so a subtree's legend lists only its own labels.
function assembleDisplayGraph(
  nodes: DisplayNode[],
  edges: DisplayEdge[],
  ns: string,
  slot: string,
  note: string,
): DisplayGraph {
  const byLabel: Record<string, number> = {};
  for (const n of nodes) byLabel[n.label] = (byLabel[n.label] ?? 0) + 1;
  const sources = [...new Set(nodes.map((n) => n.srcKey).filter(Boolean))].sort();
  // Legend taxonomy — only the LC labels actually present, in canonical order,
  // plus any unrecognised label appended (so nothing is ever silently uncoloured).
  const presentLabels = new Set(nodes.map((n) => n.label).filter(Boolean));
  const known = new Set(LABEL_DEFS.map((d) => d.key));
  const taxonomy = [
    ...LABEL_DEFS.filter((d) => presentLabels.has(d.key)),
    ...[...presentLabels].filter((l) => !known.has(l)).sort().map((l) => ({ key: l, label: { fr: l, en: l }, color: "#9aa0a6" })),
  ];

  // Label from the installed context list (so we get the pretty per-subject name).
  const ctx = listAvailableContexts().find((c) => kgNamespace(c.workspace, c.grade, c.subject) === ns);
  const label = ctx ? nsLabel(ctx.grade, ctx.subject) : { fr: ns, en: ns };

  return {
    nodes,
    edges,
    meta: {
      ns,
      label,
      publishedSlot: slot,
      counts: { nodes: nodes.length, edges: edges.length, byKind: byLabel },
      sources,
      taxonomy,
      viewConfig: buildViewConfig(nodes, edges),
      generatedAt: new Date().toISOString(),
      note,
    },
  };
}

// ── Export one namespace (published slot only) ───────────────────────────────
export async function exportNamespace(ns: string): Promise<DisplayGraph | null> {
  const store = getKgStore();
  const pointer = await store.readPointer(ns);
  if (!pointer) return null; // never seeded

  const slot = pointer.publishedSlot;
  const [storedNodes, storedEdges] = await Promise.all([
    store.listNodes(ns, slot),
    store.listEdges(ns, slot),
  ]);

  // The store holds the FULL Learning-Commons graph (spine + framework/derived
  // nodes + supports/relatesTo cross-links); the explorer renders all of it as-is.
  // No subject-specific post-processing — nodes are coloured by LC label, the
  // hierarchy walks hasChild, and the generic view exposes every node + edge.
  const nodes = storedNodes.map(toDisplayNode);
  const edges = projectDisplayEdges(nodes, storedEdges);
  return assembleDisplayGraph(
    nodes,
    edges,
    ns,
    slot,
    "Read-only, published slot only (no draft). Full Learning-Commons graph — the curriculum spine plus framework/derived nodes and supports/relatesTo cross-links.",
  );
}

// ── Export a scoped subtree (for an in-chat visualization artifact) ───────────
// Returns the containment descendants of `fromId` as a self-contained DisplayGraph
// — the SAME shape exportNamespace returns, so the explorer's view engine renders
// it unchanged, just over a smaller slice. "Containment" is the folded hasChild
// display axis (hasPart + reversed supports/alignment + illustrates + usesRoutine
// all collapse onto it in toDisplayEdges), i.e. exactly the tree the explorer
// walks — so this is one Course / chapter / week and everything nested beneath it.

const SUBTREE_DEFAULT_DEPTH = 4;
const SUBTREE_MAX_DEPTH = 12;
// Keep the scoped payload under the 100 KB global asJson cap, so the artifact
// data comes back as a normal response rather than being withheld. Measured the
// way asJson serializes it (pretty-printed). Leaves headroom for the wrapper.
// Tunable for ops (and tests) via TLM_SUBTREE_MAX_BYTES, mirroring walk_graph's
// TLM_WALK_MAX_PAGE_BYTES.
const DEFAULT_SUBTREE_MAX_BYTES = 80 * 1024;
const subtreeMaxBytes = (): number => {
  const override = Number(process.env.TLM_SUBTREE_MAX_BYTES);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_SUBTREE_MAX_BYTES;
};

const clampDepth = (depth: number): number =>
  Math.min(SUBTREE_MAX_DEPTH, Math.max(1, Math.floor(depth)));

const displayGraphBytes = (graph: DisplayGraph): number =>
  Buffer.byteLength(JSON.stringify(graph, null, 2), "utf8");

// The scoped node set for a subtree: the containment descendants of `fromId`,
// PLUS the alignment tail the Curriculum view grafts onto content leaves (a
// lesson/activity's aligned standard, and that standard's supporting components)
// so the "lesson → standard → components" branch renders instead of folding away.
//
// Both are computed over the display edges, which fold every containment/alignment
// edge onto r === "hasChild" while keeping the REAL type in `rel`:
//   • hasPart / usesRoutine / supports fold as parent(s) → child(t)  — walked outward.
//   • hasEducationalAlignment / illustrates fold as standard/component(s) → content(t).
// The tail closure is DIRECTIONAL, matching the view engine's alignmentTail: an
// in-scope content node pulls IN its standard (not the standard's other lessons),
// and an in-scope standard pulls in its components — so the scope stays a bounded
// lesson↔standard↔components star, never the whole spine.
const ALIGN_TO_PARENT_RELS = new Set(["hasEducationalAlignment", "illustrates"]); // content(t) → add its parent(s)
const SUPPORT_REL = "supports"; // standard(s) → add its component(t)

function scopedSubtreeIds(edges: DisplayEdge[], fromId: string, maxDepth: number): Set<string> {
  // 1. Containment descendants — BFS outward over folded hasChild, bounded to
  //    `maxDepth` hops, shortest-hop visitation like walk_graph.
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (e.r !== "hasChild") continue;
    const list = childrenOf.get(e.s) ?? [];
    list.push(e.t);
    childrenOf.set(e.s, list);
  }
  const reached = new Set<string>([fromId]);
  let frontier = [fromId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of childrenOf.get(id) ?? []) {
        if (!reached.has(child)) {
          reached.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }

  // 2. Alignment-tail closure to a fixpoint (bounded: content → standard →
  //    components is only two levels, so this settles in a couple of passes).
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      if (e.r !== "hasChild") continue;
      if (ALIGN_TO_PARENT_RELS.has(e.rel) && reached.has(e.t) && !reached.has(e.s)) {
        reached.add(e.s); // content in scope → add the standard/component it aligns to
        changed = true;
      } else if (e.rel === SUPPORT_REL && reached.has(e.s) && !reached.has(e.t)) {
        reached.add(e.t); // standard in scope → add its supporting component
        changed = true;
      }
    }
  }
  return reached;
}

// Drop the per-node raw LC `props` bag — the detail-panel data — to shrink the
// payload when the caller doesn't need it (the default) or when the full-detail
// slice would overflow the budget.
const stripProps = (nodes: DisplayNode[]): DisplayNode[] =>
  nodes.map((n) => ({ ...n, props: {} }));

export type SubtreeExport =
  | DisplayGraph
  | { error: string }
  | { tooLarge: true; counts: { nodes: number; edges: number }; approxBytes: number; softCapBytes: number; message: string };

export async function exportSubtree(
  ns: string,
  fromId: string,
  opts: { maxDepth?: number; detail?: boolean } = {},
): Promise<SubtreeExport | null> {
  const store = getKgStore();
  const pointer = await store.readPointer(ns);
  if (!pointer) return null; // never seeded

  const slot = pointer.publishedSlot;
  const [storedNodes, storedEdges] = await Promise.all([
    store.listNodes(ns, slot),
    store.listEdges(ns, slot),
  ]);

  const allNodes = storedNodes.map(toDisplayNode);
  if (!allNodes.some((n) => n.id === fromId)) {
    return { error: `Start node '${fromId}' not found in the published graph for '${ns}'. Use namespace_stats to find a root (a Course/chapter), or walk_graph to find a node id.` };
  }
  const allEdges = projectDisplayEdges(allNodes, storedEdges);

  const maxDepth = clampDepth(opts.maxDepth ?? SUBTREE_DEFAULT_DEPTH);
  const scopedIds = scopedSubtreeIds(allEdges, fromId, maxDepth);
  const scopedNodes = allNodes.filter((n) => scopedIds.has(n.id));
  // Keep every display edge whose BOTH endpoints are in scope — so cross-links
  // among in-scope nodes (buildsTowards, relatesTo) render too, not just the
  // containment tree we walked.
  const scopedEdges = allEdges.filter((e) => scopedIds.has(e.s) && scopedIds.has(e.t));

  const note = `Read-only, published slot only (no draft). Scoped subtree from '${fromId}' (containment descendants to depth ${maxDepth}) — a self-contained slice for a single visualization.`;
  const build = (detail: boolean): DisplayGraph =>
    assembleDisplayGraph(detail ? scopedNodes : stripProps(scopedNodes), scopedEdges, ns, slot, note);

  // Honour the requested detail, but fall back to props-stripped if the detailed
  // slice would overflow the budget; if even the lean slice overflows, refuse
  // with a sized, actionable message rather than tripping the generic cap.
  const budget = subtreeMaxBytes();
  let graph = build(opts.detail ?? false);
  if (displayGraphBytes(graph) > budget && (opts.detail ?? false)) {
    graph = build(false);
  }
  const bytes = displayGraphBytes(graph);
  if (bytes > budget) {
    return {
      tooLarge: true,
      counts: { nodes: scopedNodes.length, edges: scopedEdges.length },
      approxBytes: bytes,
      softCapBytes: budget,
      message: `The subtree from '${fromId}' (${scopedNodes.length} nodes, ${scopedEdges.length} edges at depth ${maxDepth}) is ~${Math.round(bytes / 1024)} KB, over the ~${Math.round(budget / 1024)} KB budget for one visualization payload. Lower maxDepth, pick a deeper root (a chapter/week rather than the whole Course), or view the full graph in the live explorer instead.`,
    };
  }
  return graph;
}

// ── Export the catalog libraries visible from a namespace ─────────────────────
// The explorer's Catalog tab. Given a curriculum namespace (workspace:grade:subject),
// it reads the two libraries a curator of that workspace can browse — the shared
// cross-tenant library and the workspace's own — and returns their entries. Each
// entry already carries its scope (shared | workspace), kind (routine | formatter),
// name, summary, ordered steps, and material count (see listCatalogEntries).
//
// This mirrors the server's list_catalog tool, but keyed by namespace rather than by
// the active session context (the read routes are stateless — no set_context).

export type CatalogScopeEntry = { scope: CatalogScope; namespace: string };
export type CatalogExport = { scopes: CatalogScopeEntry[]; entries: CatalogEntry[] };

// Read one catalog namespace's published slot as a plain graph. Empty when that
// library has never been seeded (no pointer) — mirrors server/catalog.ts::readCatalog,
// duplicated here so the read routes don't reach up into the server (app) layer.
async function readCatalogGraph(namespace: string): Promise<MutationGraph> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer) return { nodes: [], edges: [] };
  const [nodes, edges] = await Promise.all([
    store.listNodes(namespace, pointer.publishedSlot),
    store.listEdges(namespace, pointer.publishedSlot),
  ]);
  const dropSlot = <T extends { slot: unknown }>(x: T): Omit<T, "slot"> => { const { slot, ...rest } = x; return rest; };
  return { nodes: nodes.map((n) => dropSlot(n) as MutationNode), edges: edges.map((e) => dropSlot(e) as MutationEdge) };
}

// The catalog scopes reachable from a curriculum namespace: the shared library
// always, plus that namespace's workspace library (dropped when the workspace IS
// the shared one, so there is just one library). null for a non-curriculum ns
// (e.g. a reserved `_catalog` partition), which owns no catalog view.
function catalogScopesFor(ns: string): CatalogScopeEntry[] | null {
  const parsed = parseNamespace(ns);
  if (!parsed) return null;
  const scopes: CatalogScopeEntry[] = [{ scope: "shared", namespace: SHARED_CATALOG_NAMESPACE }];
  const workspaceNs = catalogNamespace(parsed.workspace);
  if (workspaceNs !== SHARED_CATALOG_NAMESPACE) scopes.push({ scope: "workspace", namespace: workspaceNs });
  return scopes;
}

export async function exportCatalog(ns: string): Promise<CatalogExport | null> {
  const scopes = catalogScopesFor(ns);
  if (!scopes) return null;
  const perScope = await Promise.all(scopes.map(async (s) => listCatalogEntries(await readCatalogGraph(s.namespace), s.scope)));
  return { scopes, entries: perScope.flat() };
}

// One catalog entry's FULL authored spec as markdown (the click-through detail the
// list only counts). Searches the same two libraries; null when the id isn't an
// entry in either. Mirrors the get_catalog_entry tool.
export async function exportCatalogEntry(ns: string, id: string): Promise<string | null> {
  const scopes = catalogScopesFor(ns);
  if (!scopes) return null;
  for (const s of scopes) {
    const markdown = renderCatalogEntry(await readCatalogGraph(s.namespace), id, s.scope);
    if (markdown) return markdown;
  }
  return null;
}
