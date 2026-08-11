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
  label: string;                 // Learning-Commons ontology label (drives colour/stats)
  kind: string;                  // the raw store `type` (chapter/lesson/component/task/week/standard…)
  nt: string;                    // nodeType (e.g. "Activity") — used for the task stats chip
  st: string; st_en: string;     // category (statement_type) FR/EN
  code: string;                  // statementCode, e.g. "Leçon 64"
  ord: number | null;            // the node's own number (metadata.order)
  desc: string; desc_en: string; // display label text
  ex: string[]; ex_en: string[]; // examples
  grp: string; res: string; niv: string;
  apt: string; apt_en: string;
  comm: string; comm_en: string;
  sem: number | string; pal: number | string;
  chapN: number | string; chapT: string; chapT_en: string;
  dom: string; dom_en: string;
  os: string; os_en: string;
  src: string; ref: string; statut: string; statut_en: string;
  srcKey: string;                // source key → drives the source-filter chips
  strand: string; genre: string; // CE1 CE1 reading extras (harmless/empty for CI maths)
  cat: string;                   // graph-agnostic legend category (see categoryOf) — drives colour/legend/stats
};

// ── Graph-agnostic taxonomy (drives legend, node colour, and stats) ──────────
// The explorer must speak ONE vocabulary across every subject, so it never
// hardcodes subject words like "chapter"/"lesson". Each display node is tagged
// with a `cat` drawn from the converged Learning-Commons `metadata.role` (for
// containers) or the node kind (for the two leaf types). `meta.taxonomy` then
// lists — in canonical order — only the categories actually present, each with a
// bilingual label + colour, so the page renders whatever it is handed.
export type TaxonomyEntry = { key: string; label: { fr: string; en: string }; color: string };

// Colours reuse the page's existing palette (kept in sync with the CSS vars in
// hosting/public/index.html). One colour per category — no per-domain rainbow.
const CATEGORY_DEFS: TaxonomyEntry[] = [
  { key: "strand",      label: { fr: "Composante",                en: "Strand" },             color: "#7f77dd" },
  { key: "subtopic",    label: { fr: "Sous-thème",                en: "Subtopic" },           color: "#378add" },
  { key: "expectation", label: { fr: "Objectif spécifique",       en: "Expectation" },        color: "#1d9e75" },
  { key: "component",   label: { fr: "Composant d'apprentissage", en: "Learning component" }, color: "#d4537e" },
  { key: "task",        label: { fr: "Tâche illustrative",        en: "Illustrative task" },  color: "#c98a1a" },
  { key: "week",        label: { fr: "Semaine",                   en: "Week" },               color: "#888780" },
  { key: "framework",   label: { fr: "Cadre / dérivé",            en: "Framework / derived" }, color: "#9aa0a6" },
];

// Node → category. Role (converged LC scheme) wins for the container spine; the
// two leaf kinds (component/task) carry no role, so they resolve by kind.
// Non-spine nodes (framework/derived — kept only for faithful re-export) fall
// into the neutral "framework" bucket so the explorer can surface them.
function categoryOf(kind: string, role: string, spine: boolean | undefined): string {
  if (kind === "task") return "task";
  if (kind === "component") return "component";
  if (kind === "week" || role === "week") return "week";
  if (role === "strand") return "strand";
  if (role === "subtopic") return "subtopic";
  if (role === "expectation" || role === "intégration du palier") return "expectation";
  return spine === false ? "framework" : "";
}

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
  task: "Curriculum",
};

const str = (v: unknown): string => (v == null ? "" : String(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const numOrStr = (v: unknown): number | string => (typeof v === "number" ? v : v == null ? "" : String(v));

function toDisplayNode(n: StoredNode): DisplayNode {
  const p = n.properties ?? {};
  const raw = (p.raw as Record<string, unknown>) ?? {};
  const r = (k: string) => raw[k];
  // Converged LC scheme: role/order/genre/palier + English live under metadata.
  const m = (raw.metadata as Record<string, unknown>) ?? {};
  const en = (k: string) => ((m.en as Record<string, unknown>) ?? {})[k];
  // Domaine nodes have no number; order them by the canonical domain sequence so
  // the thematic view lists Arithmétique → Géométrie → Mesure → Résolution.
  const domIdx = n.type === "domaine" ? DOMAINE_ORDER.indexOf(str(p.title ?? r("description"))) : -1;
  return {
    id: n.id,
    label: (n.labels && n.labels[0]) || LABEL_BY_KIND[n.type] || n.type,
    kind: n.type,
    cat: categoryOf(n.type, str(m.role), n.spine),
    nt: str(r("normalized_statement_type") ?? r("content_type")),
    st: str(r("statement_type")),
    st_en: str(en("statement_type")),
    code: str(p.code ?? r("statement_code")),
    ord: n.type === "domaine" ? (domIdx >= 0 ? domIdx : null)
      : typeof p.order === "number" ? (p.order as number) : (typeof m.order === "number" ? (m.order as number) : null),
    desc: str(p.text ?? p.title ?? r("description") ?? r("os_texte")),
    desc_en: str(en("description") ?? en("os_texte")),
    ex: arr(r("examples")),
    ex_en: arr(en("examples")),
    grp: str(r("rece_groupe")),
    res: str(r("rece_resultat")),
    niv: str(r("rece_niveau") ?? r("rece_niveau_scolaire")),
    apt: str(r("aptitude_ci")),
    apt_en: str(en("aptitude_ci")),
    comm: str(r("commentaire_progression")),
    comm_en: str(en("commentaire_progression")),
    sem: numOrStr(r("semaine")),
    pal: numOrStr(r("palier") ?? m.palier),
    chapN: numOrStr(typeof m.order === "number" ? (m.order as number) : ""),
    chapT: "",
    chapT_en: "",
    dom: n.type === "domaine" ? str(p.title ?? r("description")) : str(r("domaine")),
    dom_en: str(en("domaine")),
    os: str(r("os_texte")),
    os_en: str(en("os_texte")),
    src: str(r("source")),
    ref: str(r("reference")),
    statut: str(r("statut")),
    statut_en: str(en("statut")),
    srcKey: str(r("source_key")),
    strand: n.type === "standard" ? str(r("statement_type")) : "",   // reading strand only
    genre: str(m.genre),
  };
}

function edgeOrder(e: StoredEdge): number {
  const p = e.properties ?? {};
  return typeof p.orderInParent === "number" ? (p.orderInParent as number)
    : typeof p.sequenceInFrom === "number" ? (p.sequenceInFrom as number)
    : typeof e.seq === "number" ? e.seq             // supports/relatesTo carry no order prop → fall back to raw sequence
    : 0;
}

// One stored edge → its DISPLAY edge(s). `supports` is CONTAINMENT in the LC
// ontology (a component/task is part-of the standard it supports), and the
// parser folds it into the hasChild child tree with the direction REVERSED
// (parent = the supported end, child = the supporting start). The explorer page
// renders a hasChild tree, so we mirror that fold here — otherwise the tree
// stops at lessons and never reaches the learning components/tasks. The store
// keeps the real `supports` edge untouched (this is display-only). hasChild /
// buildsTowards / relatesTo pass through with their own type.
function toDisplayEdges(e: StoredEdge): DisplayEdge[] {
  if (e.type === "supports") return [{ s: e.to, t: e.from, r: "hasChild", o: edgeOrder(e) }];
  return [{ s: e.from, t: e.to, r: e.type, o: edgeOrder(e) }];
}

// ── viewConfig (data-driven, from the fields actually present) ────────────────
// A namespace gets a rich "grouped-spine" view only when the fields that view
// needs are present in its data — so views are declared by SHAPE, never by
// hardcoding a namespace string. Every namespace also gets the generic
// node-type view as the floor.
const DOMAINE_ORDER = ["Arithmétique", "Géométrie", "Mesure", "Résolution de problème"];
// The six language-tool strands, in canonical order (reading's thematic buckets).
const STRAND_ORDER = ["Vocabulaire", "Grammaire", "Orthographe", "Conjugaison", "Production d'écrits", "Écriture / Copie"];

function buildViewConfig(nodes: DisplayNode[]): ViewConfig {
  const views: ViewSpec[] = [];
  const has = (kind: string) => nodes.some((n) => n.kind === kind);

  // Both subjects get the same two rich views + the generic floor.

  // THEMATIC — organized by the subject's thematic categories.
  if (has("domaine")) {
    // Maths: the real hierarchy domaine (strand) → chapter (subtopic) → OS →
    // composant → tâche, walked via hasChild (empty groupBy = domaines ARE roots).
    views.push({
      id: "thematique",
      label: { fr: "Vue thématique", en: "Thematic view" },
      shape: "grouped-spine",
      params: { anchorKind: "domaine", groupBy: [], expandEdge: "hasChild" },
    });
  } else if (has("standard")) {
    // Reading: group standards by their language-tool strand (statement_type →
    // the `strand` field), then walk hasChild to the components.
    views.push({
      id: "thematique",
      label: { fr: "Vue thématique", en: "Thematic view" },
      shape: "grouped-spine",
      params: { anchorKind: "standard", groupBy: [{ key: "strand" }], expandEdge: "hasChild", order: STRAND_ORDER },
    });
  }

  // PLANIFICATION — Palier → Semaine → contents (both subjects).
  if (has("week")) {
    views.push({
      id: "planification",
      label: { fr: "Vue planification", en: "Planning view" },
      shape: "grouped-spine",
      params: { anchorKind: "week", groupBy: [{ key: "pal", labelFr: "Palier", labelEn: "Tier" }], expandEdge: "hasChild" },
    });
  }

  // The generic floor — node-type → outgoing relations. Works for ANY namespace.
  views.push({ id: "generic", label: { fr: "Graphe (brut)", en: "Graph (raw)" }, shape: "node-type" });
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

  // ── Explorer post-processing (display only; never touches the store) ─────────
  {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const outHasChild = new Map<string, string[]>();
    for (const e of edges) if (e.r === "hasChild") (outHasChild.get(e.s) ?? outHasChild.set(e.s, []).get(e.s)!).push(e.t);

    // (1) Colour propagation — tag every CONTENT-axis descendant of a domaine with
    //     that domaine's name (domaine → chapter → OS → composant → tâche) so the
    //     explorer can colour the whole subtree. A node's own domaine wins.
    for (const dom of nodes.filter((n) => n.kind === "domaine")) {
      const name = dom.dom;
      if (!name) continue;
      const stack = [dom.id], seen = new Set<string>();
      while (stack.length) {
        for (const c of outHasChild.get(stack.pop()!) ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          const cn = byId.get(c);
          if (cn && cn.kind !== "domaine" && !cn.dom) cn.dom = name;
          stack.push(c);
        }
      }
    }

    // (2) Week palier — a maths week has no palier of its own; borrow it from a
    //     scheduled lesson (all a week's lessons share a palier) so the planning
    //     view can bucket weeks by tier. Reading weeks already carry their palier.
    for (const wk of nodes.filter((n) => n.kind === "week")) {
      if (wk.pal !== "" && wk.pal != null) continue;
      for (const c of outHasChild.get(wk.id) ?? []) {
        const cn = byId.get(c);
        if (cn && cn.pal !== "" && cn.pal != null) { wk.pal = cn.pal; break; }
      }
    }

    // (3) Surface EVERYTHING. The store now holds the full Learning-Commons
    //     graph (spine + framework/derived nodes + supports/relatesTo cross-
    //     links), so the explorer renders all of it — the grouped-spine views
    //     stay clean because they anchor on week/domaine/standard and walk
    //     hasChild, while the generic view and the `framework` legend category
    //     expose the non-spine nodes and the cross-link edges. (Previously this
    //     step dropped everything not reachable from a week/domaine root; with
    //     faithful full-graph seeding there are no dangling leftovers to hide.)
  }

  const byKind: Record<string, number> = {};
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  const sources = [...new Set(nodes.map((n) => n.srcKey).filter(Boolean))].sort();
  // Legend/colour taxonomy — only the categories actually present, canonical order.
  const presentCats = new Set(nodes.map((n) => n.cat).filter(Boolean));
  const taxonomy = CATEGORY_DEFS.filter((d) => presentCats.has(d.key));

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
      counts: { nodes: nodes.length, edges: edges.length, byKind },
      sources,
      taxonomy,
      viewConfig: buildViewConfig(nodes),
      generatedAt: new Date().toISOString(),
      note: "Read-only, published slot only (no draft). Full Learning-Commons graph — the curriculum spine plus framework/derived nodes and supports/relatesTo cross-links.",
    },
  };
}
