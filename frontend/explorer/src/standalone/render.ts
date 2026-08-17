/*
 * Standalone artifact renderer.
 *
 * A dependency-free (no React) DOM shell over the explorer's REAL view engine:
 * it imports `createGraphModel` from ../lib/graphModel verbatim, so the tree,
 * colouring, folded-containment walk, and the Standards / Curriculum /
 * Progression / By-type views are exactly what the live KG explorer shows — no
 * reimplementation to drift out of sync.
 *
 * It reads its DisplayGraph from `window.__GRAPH__` (inlined by the injector
 * script, scripts/build-graph-artifact.mjs, from an export_graph_view payload)
 * rather than fetching /kg, so the built HTML is fully self-contained and needs
 * no server or auth — which is what lets it run as a Claude artifact.
 */
import { createGraphModel, isSynth, type GraphModel } from "../lib/graphModel";
import type { DisplayGraph, Lang, ViewSpec } from "../types";
import { pick } from "../i18n";

declare global {
  interface Window { __GRAPH__?: DisplayGraph }
}

// Per-render UI state: which view tab is active, the display language, which tree
// rows are expanded (by a path key, since a node can appear under more than one
// parent in a view — e.g. a shared routine), and which views have already had
// their roots auto-expanded (so each view opens showing structure, once, while
// still respecting the user's later manual collapses).
type UiState = { viewId: string; lang: Lang; expanded: Set<string>; opened: Set<string> };

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

// A stable key for an expandable row: its ancestor path, so the same node under
// two parents expands independently and can't collide.
const rowKey = (path: string[]): string => path.join(" / ");

function mount(root: HTMLElement, data: DisplayGraph): void {
  const model = createGraphModel(data);
  const views = data.meta.viewConfig.views;
  const state: UiState = {
    viewId: views[0]?.id ?? "generic",
    lang: "fr",
    expanded: new Set(),
    opened: new Set(),
  };

  root.innerHTML = "";
  root.append(
    header(data, state, () => render()),
    legend(data, state),
  );
  const treeHost = el("div", "tree");
  root.append(treeHost);

  const render = (): void => {
    // Re-render the header/legend text on a language switch, then the tree.
    root.replaceChildren(header(data, state, render), legend(data, state), treeHost);
    const spec = views.find((v) => v.id === state.viewId) ?? views[0];
    treeHost.replaceChildren(spec ? tree(model, spec, state, render) : el("p", "empty", "No view."));
  };
  render();
}

// ── Chrome: title, counts, view tabs, language toggle ─────────────────────────
function header(data: DisplayGraph, state: UiState, render: () => void): HTMLElement {
  const bar = el("header", "hdr");
  const title = el("div", "hdr-title", pick(state.lang, data.meta.label));
  const counts = data.meta.counts;
  const sub = el(
    "div",
    "hdr-sub",
    counts ? `${counts.nodes} ${state.lang === "fr" ? "nœuds" : "nodes"} · ${counts.edges} ${state.lang === "fr" ? "relations" : "edges"}` : "",
  );
  const left = el("div");
  left.append(title, sub);

  const lang = el("button", "lang", state.lang === "fr" ? "EN" : "FR");
  lang.onclick = () => { state.lang = state.lang === "fr" ? "en" : "fr"; render(); };

  const top = el("div", "hdr-top");
  top.append(left, lang);
  bar.append(top);

  const tabs = el("nav", "tabs");
  for (const view of data.meta.viewConfig.views) {
    const tab = el("button", "tab" + (view.id === state.viewId ? " on" : ""), pick(state.lang, view.label));
    tab.onclick = () => { state.viewId = view.id; render(); };
    tabs.append(tab);
  }
  bar.append(tabs);
  return bar;
}

function legend(data: DisplayGraph, state: UiState): HTMLElement {
  const wrap = el("div", "legend");
  for (const entry of data.meta.taxonomy) {
    const chip = el("span", "chip");
    const dot = el("span", "dot");
    dot.style.background = entry.color;
    chip.append(dot, document.createTextNode(pick(state.lang, entry.label)));
    wrap.append(chip);
  }
  return wrap;
}

// ── The tree: roots + lazily-rendered children, straight off the view engine ──
function tree(model: GraphModel, spec: ViewSpec, state: UiState, render: () => void): HTMLElement {
  const host = el("div", "rows");
  const roots = model.viewRoots(spec);
  // Expand this view's roots the first time it is shown, so it opens on structure
  // — once per view, so switching tabs reveals each view's roots but a manual
  // collapse afterwards sticks.
  if (!state.opened.has(spec.id)) {
    roots.forEach((id) => state.expanded.add(rowKey([id])));
    state.opened.add(spec.id);
  }
  for (const id of roots) host.append(row(model, spec, id, [id], state, render));
  return host;
}

function row(
  model: GraphModel,
  spec: ViewSpec,
  id: string,
  path: string[],
  state: UiState,
  render: () => void,
): HTMLElement {
  const wrap = el("div", "row-wrap");
  const line = el("div", "row");
  line.style.paddingLeft = `${(path.length - 1) * 18 + 8}px`;

  const children = model.viewChildren(spec, id, {});
  const key = rowKey(path);
  const open = state.expanded.has(key);

  const caret = el("span", "caret", children.length ? (open ? "▾" : "▸") : "");
  const dot = el("span", "dot");
  dot.style.background = model.colorFor(id);
  const label = el("span", "label", model.nodeLabel(id, state.lang));

  line.append(caret, dot, label);

  // A folded containment edge carries a real LC type — show it as a badge when
  // the parent→child link is not a plain hasChild (hasPart, supports, …).
  const parentId = path[path.length - 2];
  if (parentId && !isSynth(parentId) && !isSynth(id)) {
    const rel = model.relBetween(parentId, id);
    if (rel && rel.rel !== "hasChild") line.append(el("span", "badge", rel.rel));
  }

  if (children.length) {
    line.style.cursor = "pointer";
    line.onclick = () => { open ? state.expanded.delete(key) : state.expanded.add(key); render(); };
  }
  if (!isSynth(id)) line.append(detailToggle(model, id, state));
  wrap.append(line);

  if (open && children.length) {
    const kids = el("div", "kids");
    for (const child of children) kids.append(row(model, spec, child, [...path, child], state, render));
    wrap.append(kids);
  }
  return wrap;
}

// A small "info" affordance that reveals a node's raw LC properties inline (only
// meaningful when the export was taken with detail:true — otherwise props is {}).
function detailToggle(model: GraphModel, id: string, state: UiState): HTMLElement {
  const node = model.N[id];
  const btn = el("span", "info", "ⓘ");
  btn.title = node?.code || node?.label || id;
  btn.onclick = (event) => {
    event.stopPropagation();
    const existing = (btn.parentElement?.parentElement?.querySelector(".detail")) as HTMLElement | null;
    if (existing) { existing.remove(); return; }
    btn.parentElement?.parentElement?.append(detail(model, id, state));
  };
  return btn;
}

function detail(model: GraphModel, id: string, state: UiState): HTMLElement {
  const node = model.N[id];
  const box = el("div", "detail");
  box.append(el("div", "detail-h", `${node?.label ?? "?"} — ${node?.code || id}`));
  const text = model.desc(node, state.lang);
  if (text) box.append(el("div", "detail-desc", text));
  const props = node?.props ?? {};
  const keys = Object.keys(props);
  if (!keys.length) {
    box.append(el("div", "detail-empty", state.lang === "fr"
      ? "Détails non inclus (exportez avec detail:true)."
      : "Details not included (export with detail:true)."));
  } else {
    const list = el("dl", "detail-props");
    for (const k of keys) {
      list.append(el("dt", undefined, k));
      list.append(el("dd", undefined, typeof props[k] === "object" ? JSON.stringify(props[k]) : String(props[k])));
    }
    box.append(list);
  }
  return box;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
const data = window.__GRAPH__;
const container = document.getElementById("app");
if (container) {
  if (data && data.nodes?.length) mount(container, data);
  else container.append(el("p", "empty", "No graph data was inlined into this page."));
}
