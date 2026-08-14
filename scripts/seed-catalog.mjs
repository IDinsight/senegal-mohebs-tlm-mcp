#!/usr/bin/env node
/*
 * Idempotent seed for the SHARED ROUTINE CATALOG (a single cross-context library,
 * not a subject graph).
 *
 * It scans the installed sources, extracts every subject's InstructionalRoutine
 * subtrees, re-homes them under one root container, and writes the result to the
 * reserved catalog namespace (SHARED_CATALOG_NAMESPACE), slot "a" — the same slot/pointer
 * discipline as seed-kg-store. Non-routine content (chapters, lessons, the standards
 * spine) is dropped; the catalog holds only routines. Ids are preserved and the root
 * id is fixed, so a re-seed overwrites the same docs (idempotent).
 *
 * Today only CI maths carries routines (the two "Fiche de leçon" + "Structure d'un
 * chapitre" entries), so that is what seeds; any subject that later gains routines is
 * picked up automatically.
 *
 * Usage:
 *   npm run build                         # compile TS to dist/ first
 *   node scripts/seed-catalog.mjs         # seed the catalog (Firestore)
 *   node scripts/seed-catalog.mjs --dry-run   # in-memory store; no writes, prints a summary
 *
 * Env: same Firebase auth as seed-kg-store (SERVICE_ACCOUNT_KEY_PATH / _JSON,
 * FIREBASE_STORAGE_BUCKET, TLM_SOURCES_DIR, TLM_BUCKET_PREFIX).
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(REPO, "dist");
if (!existsSync(DIST)) {
  console.error("seed-catalog: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { CONFIG } = await import(new URL("../dist/config.js", import.meta.url));
const { listAvailableContexts, subjectDir } = await import(new URL("../dist/context/index.js", import.meta.url));
const { createMemoryKgStore, createFirestoreKgStore } = await import(new URL("../dist/kg-store/index.js", import.meta.url));
const { assembleCatalog, SHARED_CATALOG_NAMESPACE, HOUSE_STYLE_FORMATTER } = await import(new URL("../dist/kg-recipes/index.js", import.meta.url));

const dryRun = process.argv.slice(2).includes("--dry-run");

// Read every installed source's raw graph (assembleCatalog keeps only the routine
// subtrees), plus the authored house-style formatter.
const sources = [];
let hashes = "";
for (const { workspace, grade, subject } of listAvailableContexts()) {
  const bundlePath = resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile);
  if (!existsSync(bundlePath)) continue;
  const bytes = readFileSync(bundlePath);
  hashes += createHash("sha256").update(bytes).digest("hex");
  const parsed = JSON.parse(bytes.toString("utf8"));
  sources.push({ nodes: parsed.nodes ?? [], relationships: parsed.relationships ?? parsed.edges ?? [] });
}
sources.push(HOUSE_STYLE_FORMATTER);

const { nodes, edges } = assembleCatalog(sources);
const routineCount = nodes.filter((n) => (n.labels ?? []).includes("InstructionalRoutine")).length;
const entryCount = edges.filter((e) => e.type === "hasPart" && e.from === "catalog-root").length;

const store = dryRun ? createMemoryKgStore() : createFirestoreKgStore();
console.error(`seed-catalog: backend=${store.kind}, ns='${SHARED_CATALOG_NAMESPACE}', ${entryCount} entries, ${nodes.length} nodes, ${edges.length} edges.`);

const meta = {
  contentHash: createHash("sha256").update(hashes).digest("hex"),
  seededAt: new Date().toISOString(),
  adapterId: "shared-routine-catalog",
  nodeCount: nodes.length,
  edgeCount: edges.length,
};

try {
  const existing = await store.readPointer(SHARED_CATALOG_NAMESPACE);
  await store.writeSlot(SHARED_CATALOG_NAMESPACE, "a", { nodes, edges, meta });
  await store.ensurePointer(SHARED_CATALOG_NAMESPACE, "a");
  const after = await store.readPointer(SHARED_CATALOG_NAMESPACE);
  const note = existing && after && after.publishedSlot !== "a"
    ? ` (WARNING: publishedSlot is '${after.publishedSlot}', not 'a' — this re-seed wrote a non-published slot)`
    : "";
  console.error(`seed-catalog: OK — ${entryCount} entries, ${routineCount} routine nodes, hash=${meta.contentHash.slice(0, 12)}…${note}`);
} catch (e) {
  console.error(`seed-catalog: FAILED — ${(e && e.message) || e}`);
  process.exit(2);
}
console.error("seed-catalog: done.");
