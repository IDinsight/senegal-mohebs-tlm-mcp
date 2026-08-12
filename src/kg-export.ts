// ── Layer: app · read-only KG export ─────────────────────────────────────────
// Backs the live KG explorer (a hosted static page). Reads the PUBLISHED slot of
// the generic node/edge store and transforms it into the "display schema" the
// explorer's views + modal consume. READ-ONLY and published-only: it resolves
// the pointer's publishedSlot and never touches drafts, so a curator's in-flight
// edit never leaks here until they publish.
//
// This is purely additive — it reuses the same store the MCP read/curator tools
// use (getKgStore + readPointer/listNodes/listEdges), and reuses the same
// namespace enumeration (listAvailableContexts × a published pointer). It does
// NOT go through the subject adapters' presenter layer (get_curriculum), because
// the explorer needs the WHOLE spine graph (every node + edge), not a
// per-unit slice. It reads the same normalized store those adapters hydrate from.
//
// Data-scope note (see docs/design-notes/kg-explorer-findings.md): the store now holds the
// FULL Learning-Commons graph — the curriculum spine (for CI maths
// `domaine → chapter → lesson → component → task` via hasChild, plus
// `chapter → chapter` buildsTowards; for CE1 reading `week → standard →
// component`) AND the framework/derived nodes + supports/relatesTo cross-links
// that used to be dropped at ingest. The explorer surfaces all of it: spine
// nodes keep their category, non-spine nodes fall into the neutral `framework`
// legend bucket, and every edge type renders.
import { getKgStore, kgNamespace } from "./kg-store/index.js";
import type { StoredNode, StoredEdge } from "./kg-store/index.js";
import { listAvailableContexts } from "./context/index.js";

// ── Display schema (what the explorer consumes) ──────────────────────────────
// Node fields mirror the uploaded ci_kg_explorer_1.html DATA schema so the fork
// renders them unchanged; edges use {s,t,r} + an order hint `o`.
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

// One colour per LC label (palette kept in sync with hosting/public/index.html).
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
];

export type DisplayEdge = { s: string; t: string; r: string; o: number };

export type GroupByLevel = { key: keyof DisplayNode | string; labelFr?: string; labelEn?: string };
export type ViewSpec =
  | {
      id: string; label: { fr: string; en: string }; shape: "grouped-spine";
      params: { anchorKind: string; groupBy: GroupByLevel[]; expandEdge: string; stopKind?: string | null; order?: string[] };
    }
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
  Array<{ ns: string; grade: string; subject: string; label: { fr: string; en: string } }>
> {
  const store = getKgStore();
  const out: Array<{ ns: string; grade: string; subject: string; label: { fr: string; en: string } }> = [];
  for (const { grade, subject } of listAvailableContexts()) {
    const ns = kgNamespace(grade, subject);
    const pointer = await store.readPointer(ns).catch(() => null);
    if (!pointer) continue; // never seeded → not selectable
    out.push({ ns, grade, subject, label: nsLabel(grade, subject) });
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

// One stored edge → its DISPLAY edge(s). The explorer renders a single "hasChild"
// containment tree, so we normalise canonical LC's edges onto it (display-only —
// the store keeps the real edges):
//   • `hasPart` (content containment) → forward display hasChild.
//   • `supports` (component→SFI) and `hasEducationalAlignment` (lesson/activity→SFI)
//     are alignment/part-of the standard: fold REVERSED (parent = the supported
//     end) so components/lessons stay reachable under the standard they align to.
//   • hasChild / buildsTowards / relatesTo pass through with their own type.
function toDisplayEdges(e: StoredEdge): DisplayEdge[] {
  if (e.type === "supports" || e.type === "hasEducationalAlignment") return [{ s: e.to, t: e.from, r: "hasChild", o: edgeOrder(e) }];
  if (e.type === "hasPart") return [{ s: e.from, t: e.to, r: "hasChild", o: edgeOrder(e) }];
  return [{ s: e.from, t: e.to, r: e.type, o: edgeOrder(e) }];
}

// ── viewConfig — Learning-Commons ontology views ONLY ────────────────────────
// No subject anchors (no domaine/week/strand/palier). Two views:
//   1. HIERARCHY — the containment tree, anchored on the LC framework root and
//      expanded via `hasChild` (the LC part-of relation; `supports` folds into it,
//      see toDisplayEdges), so the whole spine + components render as one tree.
//   2. BY-LABEL — the generic node-type floor: every node grouped by its LC label,
//      each showing its outgoing relations. Works for any namespace.
function buildViewConfig(nodes: DisplayNode[]): ViewConfig {
  const views: ViewSpec[] = [];
  if (nodes.some((n) => n.label === "StandardsFramework")) {
    views.push({
      id: "hierarchy",
      label: { fr: "Hiérarchie (contenance)", en: "Hierarchy (containment)" },
      shape: "grouped-spine",
      params: { anchorKind: "StandardsFramework", groupBy: [], expandEdge: "hasChild" },
    });
  }
  views.push({ id: "generic", label: { fr: "Par type (LC)", en: "By type (LC)" }, shape: "node-type" });
  return { views };
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

  let nodes = storedNodes.map(toDisplayNode);
  let edges = storedEdges.flatMap(toDisplayEdges);

  // The store holds the FULL Learning-Commons graph (spine + framework/derived
  // nodes + supports/relatesTo cross-links); the explorer renders all of it as-is.
  // No subject-specific post-processing — nodes are coloured by LC label, the
  // hierarchy walks hasChild, and the generic view exposes every node + edge.

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
  const ctx = listAvailableContexts().find((c) => kgNamespace(c.grade, c.subject) === ns);
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
      viewConfig: buildViewConfig(nodes),
      generatedAt: new Date().toISOString(),
      note: "Read-only, published slot only (no draft). Full Learning-Commons graph — the curriculum spine plus framework/derived nodes and supports/relatesTo cross-links.",
    },
  };
}
