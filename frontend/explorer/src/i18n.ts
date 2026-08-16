import type { Bilingual, Lang } from "./types";

// UI chrome strings only — graph content is already bilingual in the data and is
// picked with `pick()` below. Ported verbatim from the original explorer.
export const UI = {
  fr: {
    title: "Explorateur — Graphes de connaissances",
    sub: "Ontologie Learning Commons · lecture seule (graphe publié)",
    filtres: "Filtres",
    sourcesSub: "Sources — sélection multiple",
    tout: "Tout",
    aucune: "Aucune",
    search: "Rechercher un nœud…",
    expandAll: "Tout déplier",
    collapseAll: "Tout replier",
    noeuds: "nœuds",
    relations: "relations",
    taches: "tâches",
    loading: "Chargement du graphe…",
    loadingNs: "Chargement des graphes…",
    empty: "Ce graphe ne contient aucun nœud.",
    errServer: "Impossible de joindre le serveur.",
    errLoad: "Échec du chargement du graphe.",
    retry: "Réessayer",
    signin: "Se connecter",
    loginTitle: "Connexion",
    loginFail: "Échec de la connexion : ",
    hintGrouped:
      "Cliquez sur une ligne pour la déplier/replier ; l'icône œil ouvre la fiche du nœud. Vue en lecture seule du graphe publié.",
    hintGeneric:
      "Vue générique : chaque type de nœud, puis ses nœuds, puis leurs relations sortantes. L'icône œil ouvre une fiche.",
    properties: "Propriétés",
    parent: "Parent",
    children: "Enfants",
    prepTo: "Prépare à (buildsTowards →)",
    builtFrom: "Construit à partir de (buildsTowards ←)",
    noRel: "Aucune relation supplémentaire.",
    close: "Fermer",
    view: "Voir la fiche",
  },
  en: {
    title: "Explorer — Knowledge graphs",
    sub: "Learning Commons ontology · read-only (published graph)",
    filtres: "Filters",
    sourcesSub: "Sources — multi-select",
    tout: "All",
    aucune: "None",
    search: "Search for a node…",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    noeuds: "nodes",
    relations: "relationships",
    taches: "tasks",
    loading: "Loading graph…",
    loadingNs: "Loading knowledge graphs…",
    empty: "This graph contains no nodes.",
    errServer: "Could not reach the server.",
    errLoad: "Failed to load the graph.",
    retry: "Retry",
    signin: "Sign in",
    loginTitle: "Sign in",
    loginFail: "Sign-in failed: ",
    hintGrouped:
      "Click a row to expand / collapse it; the eye icon opens the node's detail panel. Read-only view of the published graph.",
    hintGeneric:
      "Generic view: each node type, then its nodes, then their outgoing relationships. The eye icon opens a detail panel.",
    properties: "Properties",
    parent: "Parent",
    children: "Children",
    prepTo: "Prepares for (buildsTowards →)",
    builtFrom: "Built from (buildsTowards ←)",
    noRel: "No additional relationships.",
    close: "Close",
    view: "View details",
  },
} satisfies Record<Lang, Record<string, string>>;

export type UiKey = keyof (typeof UI)["fr"];

// Translate a chrome key, falling back to French then the raw key.
export function makeT(lang: Lang) {
  return (key: UiKey): string => UI[lang][key] ?? UI.fr[key] ?? key;
}

// Pick the active-language side of a bilingual value (English falls back to French).
export function pick(lang: Lang, value?: Bilingual | null): string {
  if (!value) return "";
  return lang === "en" ? value.en || value.fr : value.fr;
}
