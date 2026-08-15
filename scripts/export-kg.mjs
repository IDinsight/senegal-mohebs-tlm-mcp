#!/usr/bin/env node
/*
 * Export a namespace's PUBLISHED graph from the Firestore KG store back to a raw
 * Learning-Commons envelope JSON ({ nodes, relationships }) — the backup /
 * interchange artifact (feed it to import-kg.mjs to restore or clone a graph).
 *
 * The store holds the full raw graph, so `toRawEnvelope` reproduces the source
 * envelope faithfully. This is the "we can always export the firestore KG" path
 * (docs/design-notes/firestore-only-store.md).
 *
 * Usage (after `npm run build`):
 *   node scripts/export-kg.mjs <workspace> <grade> <subject> [out.json]
 *   # omit out.json to write to stdout
 *
 * Env: SERVICE_ACCOUNT_KEY_PATH (or SERVICE_ACCOUNT_KEY_JSON), FIREBASE_STORAGE_BUCKET,
 * TLM_BUCKET_PREFIX (match the runtime prefix so the namespace lines up).
 */
import { writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO, "dist"))) {
  console.error("export-kg: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { toRawEnvelope } = await import(new URL("../dist/curriculum/index.js", import.meta.url));
const { kgNamespace, createFirestoreKgStore } = await import(new URL("../dist/kg-store/index.js", import.meta.url));

const [workspace, grade, subject, outPath] = process.argv.slice(2);
if (!workspace || !grade || !subject) {
  console.error("export-kg: expected `<workspace> <grade> <subject> [out.json]`.");
  process.exit(1);
}

const store = createFirestoreKgStore();
const namespace = kgNamespace(workspace, grade, subject);
const pointer = await store.readPointer(namespace);
if (!pointer) {
  console.error(`export-kg: no graph in the store for namespace '${namespace}'.`);
  process.exit(2);
}
const [nodes, edges] = await Promise.all([
  store.listNodes(namespace, pointer.publishedSlot),
  store.listEdges(namespace, pointer.publishedSlot),
]);
const envelope = toRawEnvelope({ nodes, edges });
const json = JSON.stringify(envelope, null, 2);

if (outPath) {
  writeFileSync(resolve(outPath), json);
  console.error(`export-kg: wrote ${envelope.nodes.length} nodes / ${envelope.relationships.length} edges → ${outPath}`);
} else {
  process.stdout.write(json + "\n");
}
