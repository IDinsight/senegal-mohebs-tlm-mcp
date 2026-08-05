// ── Layer: app · entry point ─────────────────────────────────────────────────
// Boots the MCP server: apply an optional startup context, reconcile once, serve
// over stdio. Also the package's public export surface (for tests/embedding).
//
// Module layout (imports only ever point DOWN this list — enforced by
// scripts/check-cycles.mjs; see docs/multi-subject-architecture.md):
//
//   app       server/* · index.ts · activate.ts
//   adapters  adapters/*            — one per-subject behavior module
//   services  storage/* · curriculum/* · generation/* · kg-store/*   — never import adapters
//   core      config.ts · types.ts · context/{state,shared} · utils/*   — leaves
//
// Cross-module imports go through each module's index.ts (barrel); files inside
// a module import their siblings directly. activate.ts is app-layer glue (it
// wires context + adapters), so it lives at the root, not inside the leaf context/.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server/index.js";
import { CONFIG, kgSource } from "./config.js";
import { getActiveContext, listAvailableContexts } from "./context/index.js";
import { activateContext } from "./activate.js";
import { getActiveAdapter } from "./adapters/index.js";
import { reconcile } from "./storage/index.js";
import { installProcessGuards } from "./utils/index.js";

export { CONFIG } from "./config.js";
export { getActiveContext, listAvailableContexts } from "./context/index.js";
export { activateContext } from "./activate.js";
export { getActiveAdapter, resolveAdapter } from "./adapters/index.js";
export { reconcile, listEntries, recordContent, extractDocxText, __setStorageForTest } from "./storage/index.js";
export { suggestFreshDomain } from "./generation/index.js";
export { searchTerminology } from "./curriculum/index.js";
export { buildServer } from "./server/index.js";
export type { StorageAdapter, StoredObject, HistoryFile, DocType, SubjectAdapter } from "./types.js";

const LOG = "[senegal-mohebs-tlm]";

// Apply an optional startup grade/subject from the environment, then reconcile
// its namespace. With no default set, we stay context-less and the first tool
// call prompts the user to choose one.
async function applyStartupContext() {
  if (CONFIG.defaultGrade && CONFIG.defaultSubject) {
    const r = await activateContext(CONFIG.defaultGrade, CONFIG.defaultSubject);
    if (!r.ok) { console.error(`${LOG} TLM_GRADE/TLM_SUBJECT '${CONFIG.defaultGrade}/${CONFIG.defaultSubject}' not activated: ${r.error}`); return; }
    console.error(`${LOG} active context: ${r.context.grade}/${r.context.subject} (kgSource=${kgSource()})`);
  }
}

async function main() {
  // Keep a stray async failure from taking the process down (see http.ts).
  installProcessGuards(LOG);
  await applyStartupContext();
  if (getActiveContext()) {
    try {
      const r = await reconcile(getActiveAdapter().deliverables);
      console.error(`${LOG} reconciled: ${r.tracked.length} tracked, ${r.untracked.length} untracked, ${r.dropped.length} dropped.`);
      if (r.untracked.length) console.error(`${LOG} untracked (need ingestion): ${r.untracked.map((u) => `${u.id} (${u.reason})`).join(", ")}`);
    } catch (e) { console.error(`${LOG} startup reconcile failed:`, (e as Error).message); }
  } else {
    const avail = listAvailableContexts().map((c) => `${c.grade}/${c.subject}`).join(", ") || "(none found)";
    console.error(`${LOG} no grade/subject set — call set_context first. Available: ${avail}`);
  }
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(`${LOG} server running on stdio`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
