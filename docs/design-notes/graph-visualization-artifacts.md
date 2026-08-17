# Graph-visualization artifacts

> **Status: Current.**

Render a scoped slice of a curriculum graph as an interactive, self-contained
HTML page inside a Claude chat — reusing the live KG explorer's view engine, not
a lookalike.

## The problem

The KG explorer (`frontend/explorer/`) is a great way to *see* a graph, but it is
a hosted React app behind Supabase auth. Inside a Claude chat we want the same
picture on demand — "show me this chapter" — without sending the user to another
site, and without shipping a 2000-node app or a big blob through an MCP tool
response (tool responses are token-budgeted; see `docs/design-notes/kg-mutations/`
and the 100 KB `asJson` cap).

## The shape

Two halves, joined by the explorer's existing `DisplayGraph` contract:

1. **Server returns *data*, scoped.** The `export_graph_view` MCP tool
   (`src/server/graph.ts` → `src/kg-export.ts::exportSubtree`) returns a
   *self-contained slice* of the published graph — the containment subtree of one
   node — in the **exact `DisplayGraph` shape** the explorer already consumes
   (`nodes`, `edges`, `meta.taxonomy`, `meta.viewConfig`, `meta.counts`). It
   reuses the explorer's projection verbatim (`toDisplayNode` / `toDisplayEdges` /
   the legend taxonomy / `buildViewConfig`, extracted into a shared
   `assembleDisplayGraph`), so a slice folds and colours identically to the whole.

2. **Claude renders the *visual*.** A build step
   (`frontend/explorer/scripts/build-graph-artifact.mjs`) esbuild-bundles the
   explorer's **real view engine** (`src/lib/graphModel.ts`) plus a small vanilla
   DOM shell (`src/standalone/render.ts`) and inlines it, with the data as
   `window.__GRAPH__`, into one self-contained HTML file — no server, no auth, no
   network — publishable as a Claude artifact.

Because `graphModel.ts` is bundled **from source**, the artifact's Standards /
Curriculum / Progression / By-type views, the folded-`hasChild` containment walk,
the honest `rel` badges, and the colouring are exactly the explorer's — there is
no hand-ported copy to drift.

## Scoping: containment + alignment tail

`exportSubtree` scopes by the folded containment axis (BFS outward over display
`hasChild` from the root, bounded by `maxDepth`), then adds the **alignment tail**
the Curriculum view grafts onto content leaves — a lesson/activity's aligned
`StandardsFrameworkItem` and that standard's supporting `LearningComponent`s — so
the "lesson → standard → components" branch renders instead of folding away. The
tail closure is directional (a content node pulls in its standard; a standard
pulls in its components), so the scope stays a bounded lesson↔standard↔components
star and never drags in the whole spine.

## Staying inside the budget

The payload is self-bounded to the response cap:

- `detail:false` (default) drops each node's raw LC property bag; `detail:true`
  includes it (for the artifact's inline detail panel).
- An oversized detailed slice auto-drops `detail`; a slice still too big returns
  `{ tooLarge, counts, message }` telling the caller to lower `maxDepth`, pick a
  deeper root (a chapter/week, not the whole Course), or use the live explorer for
  the whole graph. The budget is tunable via `TLM_SUBTREE_MAX_BYTES` (mirrors
  `walk_graph`'s `TLM_WALK_MAX_PAGE_BYTES`).

Whole-graph visualization is deliberately **out of scope** for the artifact — that
is what the hosted explorer is for.

## Producing an artifact (workflow)

1. `namespace_stats` → pick a root id (a Course/chapter/week), or `walk_graph` to
   find a deeper node.
2. `export_graph_view(fromId=<id>, maxDepth=4, detail=true)` → the scoped
   `DisplayGraph`.
3. Save that JSON, then from `frontend/explorer/`:
   `node scripts/build-graph-artifact.mjs <graph.json> <out.html> "Title"`.
4. Publish `<out.html>` as an artifact.

## Files

- `src/kg-export.ts` — `exportSubtree` + the shared `assembleDisplayGraph`
  projection (also used by the full-graph `/kg` route).
- `src/server/graph.ts` — the `export_graph_view` tool (read-only, published slot).
- `frontend/explorer/src/standalone/render.ts` — the vanilla DOM shell over
  `graphModel.ts`.
- `frontend/explorer/scripts/build-graph-artifact.mjs` — the esbuild + inline step.
