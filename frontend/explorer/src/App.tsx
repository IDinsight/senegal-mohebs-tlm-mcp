import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header, type StatChip } from "./components/Header";
import { Banner } from "./components/Banner";
import { LoginGate } from "./components/LoginGate";
import { Legend } from "./components/Legend";
import { ViewTabs, type TabSpec } from "./components/ViewTabs";
import { SourceFilters } from "./components/SourceFilters";
import { Toolbar } from "./components/Toolbar";
import { Tree } from "./components/Tree";
import { CatalogPanel } from "./components/CatalogPanel";
import { TerminologyPanel } from "./components/TerminologyPanel";
import { DetailModal } from "./components/DetailModal";
import { useGraphData } from "./hooks/useGraphData";
import { computeSearch } from "./lib/search";
import { EMPTY_URL_STATE, readUrlState, writeUrlState } from "./lib/urlState";
import { makeT, pick } from "./i18n";
import type { GraphModel } from "./lib/graphModel";
import type { Lang, ViewSpec } from "./types";

// The Catalog and Terminology tabs aren't graph views (their data lives in
// separate reserved namespaces — _catalog / _glossary — fetched on demand), so
// each rides alongside the viewConfig views as a synthetic tab with a reserved id
// and renders its own panel instead of the tree.
const CATALOG_TAB = "__catalog";
const TERMINOLOGY_TAB = "__terminology";

// Every node reachable in the current view (used by "expand all").
function allViewNodes(
  model: GraphModel,
  spec: ViewSpec,
  sourceOn: Record<string, boolean>,
): Set<string> {
  const all = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    all.add(id);
    model.viewChildren(spec, id, sourceOn).forEach(walk);
  };
  model.viewRoots(spec).forEach(walk);
  return all;
}

export default function App() {
  const [lang, setLang] = useState<Lang>("fr");
  const t = makeT(lang);
  const g = useGraphData(lang);
  const { data, model } = g;

  // Per-graph view state, reset whenever a new graph loads.
  const [currentView, setCurrentView] = useState<string | null>(null);
  const [sourceOn, setSourceOn] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Restore view/node/filters from the URL only on the FIRST graph we load (a
  // deep link or reload). Later graph switches from the dropdown start fresh at
  // defaults — the old graph's params don't belong to the new one.
  const urlRestored = useRef(false);

  useEffect(() => {
    if (!data || !model) return;
    const views = data.meta.viewConfig.views;
    const sources = data.meta.sources || [];
    const url = urlRestored.current ? EMPTY_URL_STATE : readUrlState();
    urlRestored.current = true;

    // View: honor the URL's view only if this graph actually defines it (or it's
    // a synthetic tab — Catalog / Terminology — which every graph has).
    const restoredView =
      url.view === CATALOG_TAB || url.view === TERMINOLOGY_TAB
        ? url.view
        : views.find((v) => v.id === url.view)?.id;
    setCurrentView(restoredView ?? views[0]?.id ?? null);

    // Sources: start every chip on, then turn off the ones the URL names,
    // ignoring any key this graph doesn't have (e.g. a stale link).
    const src: Record<string, boolean> = {};
    sources.forEach((k) => (src[k] = true));
    url.off.forEach((k) => {
      if (k in src) src[k] = false;
    });
    setSourceOn(src);

    // Selected node: only if it exists here; reveal its hasChild ancestors so
    // the tree opens straight to it.
    const hasNode = !!url.node && data.nodes.some((n) => n.id === url.node);
    setSelected(hasNode ? url.node : null);
    const reveal = new Set<string>();
    if (hasNode) {
      let p = model.inHasChild[url.node!];
      while (p) {
        reveal.add(p);
        p = model.inHasChild[p];
      }
    }
    setExpanded(reveal);
    setQuery("");
  }, [data, model]);

  // Mirror the current graph/view/node/filters back into the address bar so the
  // URL stays a shareable pointer to this exact spot (replaceState — no history
  // spam). Runs once the graph is ready and on every subsequent state change.
  useEffect(() => {
    if (g.phase !== "ready" || !g.currentNs) return;
    const off = Object.keys(sourceOn).filter((k) => !sourceOn[k]);
    writeUrlState({ ns: g.currentNs, view: currentView, node: selected, off });
  }, [g.phase, g.currentNs, currentView, selected, sourceOn]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const spec = useMemo<ViewSpec | null>(() => {
    if (!data || !currentView) return null;
    return data.meta.viewConfig.views.find((v) => v.id === currentView) ?? null;
  }, [data, currentView]);

  const catalogActive = currentView === CATALOG_TAB;
  const terminologyActive = currentView === TERMINOLOGY_TAB;

  // The tab strip: the graph's views, with the synthetic Catalog + Terminology
  // tabs slotted in just before the generic "Par type (LC)" floor (or appended if
  // there is none).
  const tabs = useMemo<TabSpec[]>(() => {
    if (!data) return [];
    const catalogTab: TabSpec = { id: CATALOG_TAB, label: { fr: t("catalog"), en: t("catalog") } };
    const terminologyTab: TabSpec = { id: TERMINOLOGY_TAB, label: { fr: t("terminology"), en: t("terminology") } };
    const views: TabSpec[] = data.meta.viewConfig.views;
    const genericAt = views.findIndex((v) => v.id === "generic");
    const at = genericAt === -1 ? views.length : genericAt;
    return [...views.slice(0, at), catalogTab, terminologyTab, ...views.slice(at)];
  }, [data, t]);

  // Stats chips: visible node count, per-taxonomy counts, and edges among visibles.
  const stats = useMemo<StatChip[]>(() => {
    if (!data || !model) return [];
    const vis = data.nodes.filter((n) => model.srcAllowed(n.id, sourceOn));
    const visIds = new Set(vis.map((n) => n.id));
    const byCat: Record<string, number> = {};
    vis.forEach((n) => {
      if (n.cat) byCat[n.cat] = (byCat[n.cat] || 0) + 1;
    });
    const edges = data.edges.filter((e) => visIds.has(e.s) && visIds.has(e.t)).length;
    const chips: StatChip[] = [{ value: vis.length, label: t("noeuds") }];
    (data.meta.taxonomy || []).forEach((tx) => {
      if (byCat[tx.key])
        chips.push({ value: byCat[tx.key], label: pick(lang, tx.label) });
    });
    chips.push({ value: edges, label: t("relations") });
    return chips;
  }, [data, model, sourceOn, lang, t]);

  const search = useMemo(() => {
    if (!model || !spec || !query.trim()) return null;
    return computeSearch(model, spec, query, sourceOn);
  }, [model, spec, query, sourceOn]);

  // Open a node's detail panel and reveal its hasChild ancestors in the tree.
  const openNode = useCallback(
    (id: string) => {
      setSelected(id);
      setExpanded((prev) => {
        const next = new Set(prev);
        let p = model?.inHasChild[id];
        while (p) {
          next.add(p);
          p = model?.inHasChild[p];
        }
        return next;
      });
    },
    [model],
  );

  const toggleNode = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectView = useCallback((id: string) => {
    setCurrentView(id);
    setQuery("");
    setExpanded(new Set());
  }, []);

  const expandAll = useCallback(() => {
    if (!model || !spec) return;
    const next = new Set<string>();
    allViewNodes(model, spec, sourceOn).forEach((id) => {
      if (model.viewChildren(spec, id, sourceOn).length) next.add(id);
    });
    setExpanded(next);
  }, [model, spec, sourceOn]);

  const setAllSources = useCallback((on: boolean) => {
    setSourceOn((prev) => {
      const next: Record<string, boolean> = {};
      Object.keys(prev).forEach((k) => (next[k] = on));
      return next;
    });
    setQuery("");
  }, []);

  const toggleSource = useCallback((key: string, on: boolean) => {
    setSourceOn((prev) => ({ ...prev, [key]: on }));
    setQuery("");
  }, []);

  // The graph is ready once loaded; a graph view additionally needs its spec, but
  // the synthetic tabs (Catalog / Terminology) render without one (they fetch
  // their own data).
  const ready = g.phase === "ready" && data && model && (catalogActive || terminologyActive || spec);
  const refreshing = g.phase === "loading" && g.namespaces.length > 0;

  return (
    <div className="min-h-screen">
      <Header
        lang={lang}
        title={t("title")}
        sub={t("sub")}
        stats={ready ? stats : []}
        namespaces={g.namespaces}
        currentNs={g.currentNs}
        onSelectNs={g.selectNs}
        onRefresh={g.refresh}
        refreshing={refreshing}
        onToggleLang={() => setLang((l) => (l === "fr" ? "en" : "fr"))}
      />

      {g.phase === "loading" && <Banner kind="load" text={g.loadingText} />}
      {g.phase === "error" && (
        <Banner
          kind="err"
          text={g.errorText}
          retryLabel={t("retry")}
          onRetry={g.retry}
        />
      )}
      {g.phase === "login" && <LoginGate lang={lang} onSubmit={g.login} />}

      {ready && (
        <div>
          <Legend lang={lang} taxonomy={data.meta.taxonomy || []} />
          <ViewTabs
            lang={lang}
            views={tabs}
            currentView={currentView}
            onSelect={selectView}
          />
          {catalogActive ? (
            g.currentNs && <CatalogPanel lang={lang} ns={g.currentNs} />
          ) : terminologyActive ? (
            g.currentNs && <TerminologyPanel lang={lang} ns={g.currentNs} />
          ) : (
            spec && (
              <>
                <SourceFilters
                  lang={lang}
                  sources={data.meta.sources || []}
                  sourceOn={sourceOn}
                  onToggle={toggleSource}
                  onSetAll={setAllSources}
                />
                <Toolbar
                  lang={lang}
                  query={query}
                  onQuery={setQuery}
                  onExpandAll={expandAll}
                  onCollapseAll={() => setExpanded(new Set())}
                />
                <Tree
                  lang={lang}
                  model={model}
                  spec={spec}
                  sourceOn={sourceOn}
                  expanded={expanded}
                  onToggle={toggleNode}
                  selected={selected}
                  onOpen={openNode}
                  filter={search}
                />
              </>
            )
          )}
        </div>
      )}

      {selected && model && (
        <DetailModal
          lang={lang}
          model={model}
          id={selected}
          onClose={() => setSelected(null)}
          onOpen={openNode}
        />
      )}
    </div>
  );
}
