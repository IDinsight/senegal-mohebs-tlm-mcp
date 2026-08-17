/*
 * build-graph-artifact.mjs — turn an export_graph_view payload into a single
 * self-contained HTML file, by injecting the graph data into the pre-built shell
 * (backend/assets/graph-view/shell.html, produced by build-graph-shell.mjs).
 *
 * This is the LOCAL data-file path; the backend render_graph_view tool does the
 * exact same injection at request time. The injection (escape `<`, fill the two
 * placeholders) is kept identical on both sides — see graph-view.ts::injectShell.
 *
 * If the shell is missing, run `node scripts/build-graph-shell.mjs` first.
 *
 * Usage (from frontend/explorer):
 *   node scripts/build-graph-artifact.mjs <graph.json> <out.html> ["Title"]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const shellPath = resolve(here, "../../../backend/assets/graph-view/shell.html");
const [graphPath, outPath, titleArg] = process.argv.slice(2);
if (!graphPath || !outPath) {
  console.error("usage: node scripts/build-graph-artifact.mjs <graph.json> <out.html> [title]");
  process.exit(1);
}

// The export payload may be the DisplayGraph itself or a { tooLarge } / { error }
// notice — refuse the notices rather than emit a blank page.
const graph = JSON.parse(readFileSync(resolve(graphPath), "utf8"));
if (graph.tooLarge || graph.error) {
  console.error(`Not a renderable graph: ${graph.message || graph.error}`);
  process.exit(1);
}
if (!Array.isArray(graph.nodes) || !graph.meta) {
  console.error("Input does not look like an export_graph_view DisplayGraph (missing nodes/meta).");
  process.exit(1);
}

let shell;
try {
  shell = readFileSync(shellPath, "utf8");
} catch {
  console.error(`Shell not found at ${shellPath}. Run: node scripts/build-graph-shell.mjs`);
  process.exit(1);
}

const title = titleArg || graph.meta?.label?.fr || graph.meta?.ns || "Knowledge graph";
const html = injectShell(shell, graph, title);

writeFileSync(resolve(outPath), html, "utf8");
console.log(`Wrote ${outPath} (${Math.round(Buffer.byteLength(html, "utf8") / 1024)} KB, ${graph.nodes.length} nodes, ${graph.edges.length} edges).`);

// Fill the shell's two placeholders. MUST match backend graph-view.ts::injectShell:
//   • escape `<` in the JSON so a `</script>` inside a value can't end the tag;
//   • the data placeholder is a QUOTED token, replaced by the raw JSON object.
function injectShell(shellHtml, graphObj, pageTitle) {
  const dataJson = JSON.stringify(graphObj).replace(/</g, "\\u003c");
  return shellHtml
    .replace('"__GRAPH_DATA_PLACEHOLDER__"', dataJson)
    .replace("__TITLE_PLACEHOLDER__", escapeHtml(pageTitle));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
