// Display-graph types — the shape the server's /kg endpoint returns.
// Kept in lock-step with src/kg-export.ts on the server side (DisplayNode,
// DisplayEdge, ViewSpec, DisplayGraph). If those change, update both.

export type Bilingual = { fr: string; en: string };
export type Lang = "fr" | "en";

export type DisplayNode = {
  id: string;
  label: string; // Learning-Commons ontology label — the node's identity
  kind: string; // = label (the explorer speaks LC labels only)
  cat: string; // = label (legend category → drives colour/legend/stats)
  code: string; // identifier / statement_code
  ord: number | null; // metadata.order (stable sort within a parent)
  desc: string;
  desc_en: string; // display text (bilingual)
  nt: string; // LC sub-type hint
  st: string;
  st_en: string; // LC statement_type, bilingual
  srcKey: string; // provenance → source-filter chips
  props: Record<string, unknown>; // raw LC properties, for the detail panel
};

// `r` is the traversal type (folded to "hasChild" for containment), `rel` is the
// real LC edge type used for the badge.
export type DisplayEdge = {
  s: string;
  t: string;
  r: string;
  rel: string;
  o: number;
};

export type TaxonomyEntry = { key: string; label: Bilingual; color: string };

export type GroupByLevel = {
  key: string;
  labelFr?: string;
  labelEn?: string;
};

export type ViewSpec =
  | {
      id: string;
      label: Bilingual;
      shape: "grouped-spine";
      params: {
        anchorKind: string;
        groupBy: GroupByLevel[];
        expandEdge: string;
        stopKind?: string | null;
        order?: string[];
      };
    }
  | {
      id: string;
      label: Bilingual;
      shape: "label-tree";
      params: {
        includeLabels: string[];
        expandEdge: string;
        rootKinds?: string[];
        pruneToLabel?: string;
        reverse?: boolean;
        // Grafts extra branches onto content leaves that the containment walk folds
        // away — an ordered chain of steps, each expanding a node of LC label `from`
        // along a real edge `rel` (`dir:"in"` follows it toward the node, `"out"`
        // away). Curriculum uses it for Lesson → aligned standard → supporting
        // components. Kept in lock-step with src/kg-export.ts.
        alignmentTail?: Array<{ from: string; rel: string; dir: "in" | "out" }>;
      };
    }
  | {
      id: string;
      label: Bilingual;
      shape: "progression";
      params: { edge: string };
    }
  | {
      id: string;
      label: Bilingual;
      shape: "node-type";
      params?: Record<string, never>;
    };

export type ViewConfig = { views: ViewSpec[] };

export type GraphMeta = {
  ns: string;
  label: Bilingual;
  publishedSlot?: string;
  counts?: { nodes: number; edges: number; byKind: Record<string, number> };
  sources: string[];
  taxonomy: TaxonomyEntry[];
  viewConfig: ViewConfig;
  generatedAt?: string;
  note?: string;
};

export type DisplayGraph = {
  nodes: DisplayNode[];
  edges: DisplayEdge[];
  meta: GraphMeta;
};

// One selectable knowledge graph in the header dropdown.
export type NamespaceEntry = {
  ns: string;
  workspace: string;
  grade: string;
  subject: string;
  label: Bilingual;
};

// GET /kg/config
export type KgConfig = {
  authRequired: boolean;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
};
