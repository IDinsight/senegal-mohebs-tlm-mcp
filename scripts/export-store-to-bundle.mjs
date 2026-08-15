#!/usr/bin/env node
/*
 * Export a store's PUBLISHED slot back to `sources/<…>/knowledge_graph.json`.
 *
 * The Firestore store is a faithful, re-exportable Learning-Commons copy
 * (`toRawEnvelope` reproduces the raw `{ nodes, relationships }` envelope —
 * guarded by curriculum/__tests__/faithful-reexport.test.ts). This is the tool
 * that closes the loop: when curators have published edits live (e.g. a catalog
 * formatter applied via use_formatter) that aren't in the bundle, run this to
 * fold them back into the source of truth, so a later re-seed preserves them and
 * `parity:kg-store --live` reads clean.
 *
 * Usage:
 *   npm run build
 *   node scripts/export-store-to-bundle.mjs --live [ci maths]   # write real sources/
 *   node scripts/export-store-to-bundle.mjs [ci maths]          # SELF-TEST: memory
 *        store seeded from the current bundle, exported to a temp dir + diffed
 *        (proves the round-trip without touching sources/)
 *
 * --live reads real Firestore (KG_SOURCE=firestore; requires SERVICE_ACCOUNT_KEY_PATH
 * + FIREBASE_STORAGE_BUCKET). An optional `grade subject` filters to one context.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { CONFIG } = await import(new URL("../dist/config.js", import.meta.url));
const { listAvailableContexts, subjectDir } = await import(new URL("../dist/context/index.js", import.meta.url));
const { resolveAdapter } = await import(new URL("../dist/adapters/index.js", import.meta.url));
const { serializeModel, toRawEnvelope } = await import(new URL("../dist/curriculum/index.js", import.meta.url));
const { kgNamespace, createMemoryKgStore, createFirestoreKgStore, __setKgStoreForTest } = await import(new URL("../dist/kg-store/index.js", import.meta.url));

const args = process.argv.slice(2);
const live = args.includes("--live");
const [gradeFilter, subjectFilter] = args.filter((a) => !a.startsWith("--"));

const store = live ? createFirestoreKgStore() : createMemoryKgStore();
__setKgStoreForTest(store);

const contexts = listAvailableContexts().filter(
  (c) => (!gradeFilter || c.grade === gradeFilter) && (!subjectFilter || c.subject === subjectFilter),
);

// Self-test (offline): seed the memory store from the current bundles so the
// export has data to read; it should reproduce the bundle byte-for-structure.
if (!live) {
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(workspace, grade, subject));
    await store.writeSlot(kgNamespace(workspace, grade, subject), "a", {
      nodes, edges,
      meta: { contentHash: "export-selftest", seededAt: new Date(0).toISOString(), adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length },
    });
    await store.ensurePointer(kgNamespace(workspace, grade, subject), "a");
  }
}

const outDir = live ? null : mkdtempSync(join(tmpdir(), "kg-export-"));
const stripSlot = (record) => { const { slot: _slot, ...rest } = record; return rest; };

// Order-independent fidelity: canonical (sorted-key) JSON of each node and each
// edge, compared as multisets. Nodes carry their (preserved) id; edges are keyed
// by type|from|to + properties, WITHOUT id, since the re-export re-mints edge ids.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
function bag(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}
function bagsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
function sameGraph(x, y) {
  const nodes = (g) => bag((g.nodes ?? []).map((n) => canonical({ id: n.id, labels: n.labels ?? [], properties: n.properties ?? {} })));
  const edges = (g) => bag((g.relationships ?? []).map((e) => canonical({ type: e.type, start: e.start, end: e.end, properties: e.properties ?? {} })));
  return bagsEqual(nodes(x), nodes(y)) && bagsEqual(edges(x), edges(y));
}

for (const { workspace, grade, subject } of contexts) {
  const ns = kgNamespace(workspace, grade, subject);
  const pointer = await store.readPointer(ns);
  if (!pointer) { console.error(`export: ${workspace}/${grade}/${subject}: no pointer — skipped (unseeded?)`); continue; }
  const slot = pointer.publishedSlot;

  const [nodes, edges] = await Promise.all([store.listNodes(ns, slot), store.listEdges(ns, slot)]);
  const raw = toRawEnvelope({ nodes: nodes.map(stripSlot), edges: edges.map(stripSlot) });
  const json = JSON.stringify(raw, null, 2) + "\n";

  const target = live
    ? resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile)
    : join(outDir, `${workspace}-${grade}-${subject}.json`);
  writeFileSync(target, json);

  const label = `${workspace}/${grade}/${subject}`;
  console.error(`export: ${label}: slot='${slot}', nodes=${raw.nodes.length}, relationships=${raw.relationships.length} → ${target}`);

  // Self-test: the round-trip must reproduce the bundle FAITHFULLY — the same
  // node-id set with identical labels+properties, and the same edge multiset by
  // type|from|to. It is NOT byte-identical: node order is canonicalised and edge
  // ids are regenerated deterministically (the re-export sorts + re-mints), so a
  // bundle rewritten from a store WILL reorder and re-id — review the semantic
  // diff (node count + the specific added nodes), not the raw text churn.
  if (!live) {
    const bundle = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile), "utf8"));
    const faithful = sameGraph(bundle, raw);
    console.error(`export: ${label}: round-trip ${faithful ? "OK — faithful to the bundle (order/edge-id independent)" : "DIFF — export is NOT faithful to the bundle"}`);
    if (!faithful) process.exitCode = 2;
  }
}
