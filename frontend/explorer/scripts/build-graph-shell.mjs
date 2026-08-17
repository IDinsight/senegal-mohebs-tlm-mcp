/*
 * build-graph-shell.mjs — generate the reusable, data-less HTML *shell* for
 * graph-visualization artifacts and commit it into the backend's assets.
 *
 * The shell is the whole self-contained page EXCEPT the data: the explorer's real
 * view engine (src/lib/graphModel.ts) + the vanilla DOM shell (src/standalone/
 * render.ts), esbuild-bundled from source and inlined with the CSS, plus two
 * placeholders a consumer fills in per graph:
 *   • "__GRAPH_DATA_PLACEHOLDER__"  → the DisplayGraph JSON (a JS object literal)
 *   • __TITLE_PLACEHOLDER__         → the page <title>
 *
 * Two consumers inject those placeholders identically:
 *   • the backend render_graph_view tool (reads this shell at request time), and
 *   • scripts/build-graph-artifact.mjs (the local data-file → HTML path).
 * So the template + engine live in ONE place, and the backend never has to run
 * esbuild at request time (it can't — it's a separate, self-contained package).
 *
 * Re-run this whenever graphModel.ts / render.ts / the CSS changes, then commit
 * the regenerated backend/assets/graph-view/shell.html (a committed build output,
 * like frontend/explorer/dist/).
 *
 * Usage (from frontend/explorer):  node scripts/build-graph-shell.mjs
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// backend/assets/graph-view/shell.html — resolved relative to this script so it
// works regardless of the caller's cwd.
const outDir = resolve(here, "../../../backend/assets/graph-view");
const outPath = resolve(outDir, "shell.html");

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

// Theme tokens (light default, dark override) include the three --color-* vars the
// view engine reads for synthetic rows; real node colours come from the data's
// taxonomy, so they render the same in both themes.
const shell = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__TITLE_PLACEHOLDER__</title>
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
<script>window.__GRAPH__ = "__GRAPH_DATA_PLACEHOLDER__";</script>
<script>${js}</script>
</body>
</html>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, shell, "utf8");
console.log(`Wrote ${outPath} (${Math.round(Buffer.byteLength(shell, "utf8") / 1024)} KB shell; data injected per graph).`);
