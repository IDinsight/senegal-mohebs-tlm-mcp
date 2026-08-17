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

Everything hangs off the explorer's existing `DisplayGraph` contract. There are
**two MCP tools** and one shared engine:

- **`export_graph_view` → DATA.** (`src/server/graph.ts` → `src/kg-export.ts::
  exportSubtree`) returns a *self-contained slice* of the published graph — the
  containment subtree of one node — in the **exact `DisplayGraph` shape** the
  explorer already consumes (`nodes`, `edges`, `meta.taxonomy`, `meta.viewConfig`,
  `meta.counts`). Reuses the projection verbatim (`toDisplayNode` /
  `toDisplayEdges` / the legend taxonomy / `buildViewConfig`, extracted into a
  shared `assembleDisplayGraph`), so a slice folds and colours identically to the
  whole graph. Use it when you have the repo (feed it to the local build step) or
  want the raw data.

- **`render_graph_view` → finished HTML.** (`src/kg-export.ts::renderGraphView`)
  the **one-call path**: it takes the same scoped slice and returns the *finished
  self-contained HTML page* — no local build step, no checkout needed. Success is
  the raw HTML (delivered as a text resource); save it to a `.html` and open or
  publish it.

### The engine, and why the server can't bundle it

The page is the explorer's **real view engine** — `src/lib/graphModel.ts` plus a
small vanilla DOM shell (`frontend/explorer/src/standalone/render.ts`) — esbuild-
bundled **from source**, so the Standards / Curriculum / Progression / By-type
views, the folded-`hasChild` walk, the honest `rel` badges, and the colouring are
exactly the explorer's, with no hand-ported copy to drift.

But the backend is a **separate, self-contained package** and can't run esbuild at
request time. So the bundle ships as a committed **shell**: a data-less HTML page
(engine + CSS inlined) with two placeholders — `"__GRAPH_DATA_PLACEHOLDER__"` for
the `DisplayGraph` JSON and `__TITLE_PLACEHOLDER__` for the page title.

- `frontend/explorer/scripts/build-graph-shell.mjs` esbuilds the engine and writes
  the shell to `backend/assets/graph-view/shell.html` — a **committed build
  output** (like `frontend/explorer/dist/`). Re-run it and commit when
  `graphModel.ts` / `render.ts` / the CSS change.
- Two consumers fill the placeholders **identically** (escape `<`, swap the quoted
  data token for the raw JSON object): the backend at request time
  (`renderGraphView`) and the local `build-graph-artifact.mjs` (the data-file
  path). The template + engine therefore live in exactly one place.

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
  the whole graph. `export_graph_view`'s data budget is tunable via
  `TLM_SUBTREE_MAX_BYTES` (mirrors `walk_graph`'s `TLM_WALK_MAX_PAGE_BYTES`).
- `render_graph_view` adds the ~12 KB shell on top of the compact data, so it
  applies a second page-size guard (`TLM_RENDER_MAX_BYTES`, default 96 KB, under
  the 100 KB cap) and returns the same `{ tooLarge, message }` when the whole page
  won't fit.

Whole-graph visualization is deliberately **out of scope** for the artifact — that
is what the hosted explorer is for.

## Producing an artifact (workflow)

Both paths start the same way — `namespace_stats` (or `walk_graph`) → a root id (a
Course/chapter/week).

**One call (no repo needed):**
- `render_graph_view(fromId=<id>, maxDepth=4, detail=true, title="…")` → save the
  returned HTML to a `.html` and open/publish it.

**Data + local build (when working in the repo):**
1. `export_graph_view(fromId=<id>, maxDepth=4, detail=true)` → the scoped
   `DisplayGraph`; save the JSON.
2. From `frontend/explorer/`:
   `node scripts/build-graph-artifact.mjs <graph.json> <out.html> "Title"`.
3. Publish `<out.html>`.

## Files

- `src/kg-export.ts` — `exportSubtree` (data) + `renderGraphView` (HTML) + the
  shared `assembleDisplayGraph` projection (also used by the full-graph `/kg`
  route).
- `src/server/graph.ts` — the `export_graph_view` + `render_graph_view` tools
  (read-only, published slot).
- `backend/assets/graph-view/shell.html` — the committed, data-less engine shell.
- `frontend/explorer/src/standalone/render.ts` — the vanilla DOM shell over
  `graphModel.ts`.
- `frontend/explorer/scripts/build-graph-shell.mjs` — esbuilds the engine → the
  committed shell (re-run + commit when the engine changes).
- `frontend/explorer/scripts/build-graph-artifact.mjs` — injects a data file into
  the shell (the local mirror of `renderGraphView`).
