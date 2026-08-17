/*
 * build-graph-artifact.mjs — turn an export_graph_view payload into a single
 * self-contained HTML file that renders the graph with the explorer's REAL view
 * engine (src/lib/graphModel.ts, bundled here from source via esbuild — no
 * hand-port, so it can't drift from the live explorer).
 *
 * The output inlines everything (CSS + the bundled JS + the graph data as
 * window.__GRAPH__), so it needs no server, no network, and no auth — which is
 * what makes it publishable as a Claude artifact.
 *
 * Usage (run from frontend/explorer):
 *   node scripts/build-graph-artifact.mjs <graph.json> <out.html> ["Title"]
 * where <graph.json> is the DisplayGraph returned by the export_graph_view MCP
 * tool (its top-level { nodes, edges, meta } object).
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const [graphPath, outPath, titleArg] = process.argv.slice(2);
if (!graphPath || !outPath) {
  console.error("usage: node scripts/build-graph-artifact.mjs <graph.json> <out.html> [title]");
  process.exit(1);
}

// The export payload may be the DisplayGraph itself or a { tooLarge } / { error }
// notice — refuse the notices with a clear message rather than emit a blank page.
const graph = JSON.parse(readFileSync(resolve(graphPath), "utf8"));
if (graph.tooLarge || graph.error) {
  console.error(`Not a renderable graph: ${graph.message || graph.error}`);
  process.exit(1);
}
if (!Array.isArray(graph.nodes) || !graph.meta) {
  console.error("Input does not look like an export_graph_view DisplayGraph (missing nodes/meta).");
  process.exit(1);
}

// Bundle the renderer + graphModel from source into one browser IIFE.
const bundled = await build({
  entryPoints: [resolve(here, "../src/standalone/render.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2018",
  minify: true,
  write: false,
});
const js = bundled.outputFiles[0].text;

// Inline the data safely: escape `<` so a `</script>` inside a string value can't
// terminate the inlined <script>. Same trick used for any HTML-embedded JSON.
const dataJson = JSON.stringify(graph).replace(/</g, "\\u003c");

const title = titleArg || graph.meta?.label?.fr || graph.meta?.ns || "Knowledge graph";

// Theme tokens (light default, dark override) include the three --color-* vars
// the view engine reads for synthetic rows (framework / plan / muted); real node
// colours come from the data's taxonomy, so they render the same in both themes.
const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --color-bg: #ffffff; --color-panel: #f6f7f9; --color-line: #e2e5ea;
    --color-txt: #1a1d23; --color-muted: #6b7280;
    --color-framework: #888780; --color-plan: #378add; --color-accent: #1d9e75;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --color-bg: #0f1115; --color-panel: #171a21; --color-line: #2a2f3a;
      --color-txt: #e6e8ec; --color-muted: #9aa0ab;
    }
  }
  :root[data-theme="dark"] {
    --color-bg: #0f1115; --color-panel: #171a21; --color-line: #2a2f3a;
    --color-txt: #e6e8ec; --color-muted: #9aa0ab;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--color-bg); color: var(--color-txt);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #app { max-width: 1000px; margin: 0 auto; padding: 16px; }
  .hdr-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .hdr-title { font-size: 18px; font-weight: 650; }
  .hdr-sub { color: var(--color-muted); font-size: 12px; margin-top: 2px; }
  .lang { border: 1px solid var(--color-line); background: var(--color-panel); color: var(--color-txt);
    border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 12px; }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 4px; }
  .tab { border: 1px solid var(--color-line); background: transparent; color: var(--color-muted);
    border-radius: 999px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
  .tab.on { background: var(--color-panel); color: var(--color-txt); border-color: var(--color-accent); }
  .legend { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 0 12px; border-bottom: 1px solid var(--color-line); }
  .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-muted); }
  .dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }
  .tree { margin-top: 8px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 3px 4px; border-radius: 6px; }
  .row:hover { background: var(--color-panel); }
  .caret { width: 12px; color: var(--color-muted); flex: none; }
  .label { flex: 1; min-width: 0; }
  .badge { font-size: 10px; color: var(--color-muted); border: 1px solid var(--color-line);
    border-radius: 4px; padding: 0 5px; flex: none; }
  .info { color: var(--color-muted); cursor: pointer; flex: none; padding: 0 4px; }
  .detail { margin: 2px 0 6px 28px; padding: 8px 10px; background: var(--color-panel);
    border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px; }
  .detail-h { font-weight: 600; margin-bottom: 4px; }
  .detail-desc { color: var(--color-muted); margin-bottom: 6px; }
  .detail-empty { color: var(--color-muted); font-style: italic; }
  .detail-props { display: grid; grid-template-columns: minmax(120px, auto) 1fr; gap: 2px 12px; margin: 0; }
  .detail-props dt { color: var(--color-muted); }
  .detail-props dd { margin: 0; word-break: break-word; }
  .empty { color: var(--color-muted); }
</style>
</head>
<body>
<div id="app"></div>
<script>window.__GRAPH__ = ${dataJson};</script>
<script>${js}</script>
</body>
</html>
`;

writeFileSync(resolve(outPath), html, "utf8");
const kb = Math.round(Buffer.byteLength(html, "utf8") / 1024);
console.log(`Wrote ${outPath} (${kb} KB, ${graph.nodes.length} nodes, ${graph.edges.length} edges).`);

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
