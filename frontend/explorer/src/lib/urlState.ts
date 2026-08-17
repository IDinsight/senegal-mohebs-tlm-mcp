// Reads and writes the explorer's "where am I" state to the URL query string, so
// a reload or a copied link restores the same graph, view, selected node, and
// filter chips. Only the navigation essentials are synced — free-text search is
// deliberately left out (it's transient, not a place you share).

export type UrlState = {
  ns: string | null; // which knowledge graph is loaded
  view: string | null; // active view mode (ViewSpec id)
  node: string | null; // selected node's id
  off: string[]; // source chips toggled OFF (default is all-on, so we store the exceptions)
};

export const EMPTY_URL_STATE: UrlState = {
  ns: null,
  view: null,
  node: null,
  off: [],
};

// Parse the current address bar into explorer state. Absent params read as
// null / empty, which the caller treats as "use the default".
export function readUrlState(): UrlState {
  const p = new URLSearchParams(window.location.search);
  const off = p.get("off");
  return {
    ns: p.get("ns"),
    view: p.get("view"),
    node: p.get("node"),
    off: off ? off.split(",").filter(Boolean) : [],
  };
}

// Rewrite the address bar to mirror the given state. Uses replaceState so the URL
// stays a live pointer for reload/share/bookmark without adding Back/Forward
// entries. Params at their default are omitted, keeping shared links short.
export function writeUrlState(state: UrlState): void {
  const p = new URLSearchParams();
  if (state.ns) p.set("ns", state.ns);
  if (state.view) p.set("view", state.view);
  if (state.node) p.set("node", state.node);
  if (state.off.length) p.set("off", state.off.join(","));
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}
