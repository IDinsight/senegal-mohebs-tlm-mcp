import { useCallback, useEffect, useMemo, useState } from "react";
import { Header, type StatChip } from "./components/Header";
import { Banner } from "./components/Banner";
import { LoginGate } from "./components/LoginGate";
import { Legend } from "./components/Legend";
import { ViewTabs } from "./components/ViewTabs";
import { SourceFilters } from "./components/SourceFilters";
import { Toolbar } from "./components/Toolbar";
import { Tree } from "./components/Tree";
import { DetailModal } from "./components/DetailModal";
import { useGraphData } from "./hooks/useGraphData";
import { computeSearch } from "./lib/search";
import { makeT, pick } from "./i18n";
import type { GraphModel } from "./lib/graphModel";
import type { Lang, ViewSpec } from "./types";

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

  useEffect(() => {
    if (!data) return;
    const views = data.meta.viewConfig.views;
    setCurrentView(views[0]?.id ?? null);
    const src: Record<string, boolean> = {};
    (data.meta.sources || []).forEach((k) => (src[k] = true));
    setSourceOn(src);
    setExpanded(new Set());
    setSelected(null);
    setQuery("");
  }, [data]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const spec = useMemo<ViewSpec | null>(() => {
    if (!data || !currentView) return null;
    return data.meta.viewConfig.views.find((v) => v.id === currentView) ?? null;
  }, [data, currentView]);

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

  const ready = g.phase === "ready" && data && model && spec;
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
            views={data.meta.viewConfig.views}
            currentView={currentView}
            onSelect={selectView}
          />
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
