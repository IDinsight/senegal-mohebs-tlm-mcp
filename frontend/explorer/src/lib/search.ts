import type { GraphModel } from "./graphModel";
import type { ViewSpec } from "../types";

export type SearchResult = {
  keep: Set<string>; // every node to render (matches + their ancestors)
  hits: Set<string>; // the nodes that actually matched (highlighted)
};

// Filter the current view to nodes matching `query`, keeping each match's
// ancestors so the path stays visible. Mirrors the original explorer's search:
// a real node matches on its French/English text or its code.
export function computeSearch(
  model: GraphModel,
  spec: ViewSpec,
  query: string,
  sourceOn: Record<string, boolean>,
): SearchResult {
  const q = query.toLowerCase().trim();
  const keep = new Set<string>();
  const hits = new Set<string>();
  if (!q) return { keep, hits };

  // Map every view node to its view-parent, so a match can reveal its ancestors.
  const vparent: Record<string, string> = {};
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const c of model.viewChildren(spec, id, sourceOn)) {
      vparent[c] = id;
      walk(c);
    }
  };
  model.viewRoots(spec).forEach(walk);

  const matches = (id: string): boolean => {
    const n = model.N[id];
    if (!n) return false;
    return (
      (n.desc || "").toLowerCase().includes(q) ||
      (n.desc_en || "").toLowerCase().includes(q) ||
      (n.code || "").toLowerCase().includes(q)
    );
  };

  model.data.nodes.forEach((n) => {
    if (!matches(n.id)) return;
    hits.add(n.id);
    keep.add(n.id);
    let p: string | undefined = vparent[n.id];
    while (p) {
      keep.add(p);
      p = vparent[p];
    }
  });

  return { keep, hits };
}
