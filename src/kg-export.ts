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
// Data-scope note (see docs/kg-explorer-findings.md): the store holds the
// curriculum SPINE only — for maths `chapter → lesson → component → task`
// (hasChild) + `chapter → chapter` (buildsTowards); for reading
// `week → standard → component` (hasChild). The RECE framework and the six
// derived-source family branches from the old inline-DATA explorer are NOT in
// the store; their per-leaf `sourceKey` tag survives inside `properties.raw`,
// so the source-filter chips still work, but those branches don't render.
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
  st: string; st_en: string;     // subtype (statementType) FR/EN
  code: string;                  // statementCode, e.g. "Leçon 64"
  ord: number | null;            // sort order within siblings (leconNum / chapitreNum)
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
  strand: string; genre: string; // reading extras (harmless/empty for maths)
};

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
// to the explorer's display node. Reads raw.* with both maths (camelCase) and
// reading (snake_case) spellings where they differ, so ONE mapping serves both.
const LABEL_BY_KIND: Record<string, string> = {
  chapter: "StandardsFrameworkItem",
  lesson: "StandardsFrameworkItem",
  standard: "StandardsFrameworkItem",
  week: "StandardsFramework",
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
  return {
    id: n.id,
    label: LABEL_BY_KIND[n.type] ?? n.type,
    kind: n.type,
    nt: str(r("normalizedType") ?? r("contentType")),
    st: str(r("statementType")),
    st_en: str(r("statementType_en")),
    code: str(p.code ?? r("statementCode")),
    ord: typeof p.order === "number" ? (p.order as number) : null,
    desc: str(p.text ?? r("description") ?? r("osTexte")),
    desc_en: str(r("description_en") ?? r("osTexte_en")),
    ex: arr(r("examples")),
    ex_en: arr(r("examples_en")),
    grp: str(r("receGroupe")),
    res: str(r("receResultat")),
    niv: str(r("receNiveau") ?? r("receNiveauScolaire")),
    apt: str(r("aptitudeCI")),
    apt_en: str(r("aptitudeCI_en")),
    comm: str(r("commentaireProgression")),
    comm_en: str(r("commentaireProgression_en")),
    sem: numOrStr(r("semaine")),
    pal: numOrStr(r("palier")),
    chapN: numOrStr(r("chapitreNum")),
    chapT: str(r("chapitreTitre")),
    chapT_en: str(r("chapitreTitre_en")),
    dom: str(r("domaine") ?? r("domaineCI")),
    dom_en: str(r("domaine_en")),
    os: str(r("osTexte")),
    os_en: str(r("osTexte_en")),
    src: str(r("source")),
    ref: str(r("reference")),
    statut: str(r("statut")),
    statut_en: str(r("statut_en")),
    srcKey: str(r("sourceKey")),
    strand: str(r("strand")),
    genre: str(r("genre")),
  };
}

function toDisplayEdge(e: StoredEdge): DisplayEdge {
  const p = e.properties ?? {};
  const o =
    typeof p.orderInParent === "number" ? (p.orderInParent as number)
    : typeof p.sequenceInFrom === "number" ? (p.sequenceInFrom as number)
    : 0;
  return { s: e.from, t: e.to, r: e.type, o };
}

// ── viewConfig (data-driven, from the fields actually present) ────────────────
// A namespace gets a rich "grouped-spine" view only when the fields that view
// needs are present in its data — so views are declared by SHAPE, never by
// hardcoding a namespace string. Every namespace also gets the generic
// node-type view as the floor.
const DOMAINE_ORDER = ["Arithmétique", "Géométrie", "Mesure", "Résolution de problème"];

function buildViewConfig(nodes: DisplayNode[]): ViewConfig {
  const views: ViewSpec[] = [];
  const has = (kind: string) => nodes.some((n) => n.kind === kind);
  const chaptersHaveDom = nodes.some((n) => n.kind === "chapter" && n.dom);
  const lessonsHavePalSem = nodes.some((n) => n.kind === "lesson" && n.pal !== "" && n.sem !== "");

  // Maths-shaped spine: Domaine → Chapitre → OS → composant → tâche.
  if (has("chapter") && has("lesson") && chaptersHaveDom) {
    views.push({
      id: "thematique",
      label: { fr: "Vue thématique", en: "Thematic view" },
      shape: "grouped-spine",
      params: { anchorKind: "chapter", groupBy: [{ key: "dom" }], expandEdge: "hasChild", order: DOMAINE_ORDER },
    });
    if (lessonsHavePalSem) {
      views.push({
        id: "planification",
        label: { fr: "Vue planification", en: "Planning view" },
        shape: "grouped-spine",
        params: {
          anchorKind: "lesson",
          groupBy: [
            { key: "pal", labelFr: "Palier", labelEn: "Tier" },
            { key: "sem", labelFr: "Semaine", labelEn: "Week" },
          ],
          expandEdge: "hasChild",
        },
      });
    }
    views.push({
      id: "chapitres",
      label: { fr: "Vue chapitres", en: "Chapters view" },
      shape: "grouped-spine",
      params: { anchorKind: "chapter", groupBy: [{ key: "dom" }], expandEdge: "hasChild", stopKind: "lesson", order: DOMAINE_ORDER },
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

  const nodes = storedNodes.map(toDisplayNode);
  const edges = storedEdges.map(toDisplayEdge);

  const byKind: Record<string, number> = {};
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  const sources = [...new Set(nodes.map((n) => n.srcKey).filter(Boolean))].sort();

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
      viewConfig: buildViewConfig(nodes),
      generatedAt: new Date().toISOString(),
      note: "Read-only, published slot only (no draft). Curriculum spine transformed from raw Learning-Commons nodes/edges.",
    },
  };
}
