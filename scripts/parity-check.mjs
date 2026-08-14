#!/usr/bin/env node
/*
 * Parity harness — CLI entry point. Same oracle as src/kg-store/__tests__/parity.test.ts
 * (deep-equal on parsed reads for every grade/subject and every unit), but
 * runs against whichever backend is configured at runtime — so it can be
 * pointed at a real Firestore instance to validate the seeded data before a
 * production cutover.
 *
 * Usage:
 *   npm run build
 *   node scripts/parity-check.mjs           # memory store seeded from bundle
 *   node scripts/parity-check.mjs --live    # real Firestore (KG_SOURCE=firestore)
 *                                             — requires seeded namespaces
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual, AssertionError } from "node:assert";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO, "dist"))) {
  console.error("parity-check: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { CONFIG } = await import(new URL("../dist/config.js", import.meta.url));
const { listAvailableContexts, subjectDir, newSessionState, runInSession } = await import(new URL("../dist/context/index.js", import.meta.url));
const { resolveAdapter } = await import(new URL("../dist/adapters/index.js", import.meta.url));
const { serializeModel } = await import(new URL("../dist/curriculum/index.js", import.meta.url));
const { kgNamespace, createMemoryKgStore, createFirestoreKgStore, __setKgStoreForTest } = await import(new URL("../dist/kg-store/index.js", import.meta.url));
const { __setStorageForTest } = await import(new URL("../dist/storage/index.js", import.meta.url));
const { activateContext } = await import(new URL("../dist/activate.js", import.meta.url));

const live = process.argv.includes("--live");

// Neutralise the history / bucket path — get_generation_context reads it, and
// we want the parity oracle to focus purely on the KG source dimension.
const emptyHistory = { version: 2, entries: [] };
__setStorageForTest({
  listDocuments: async () => [],
  getObjectMd5: async () => null,
  downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory,
  writeHistory: async () => {},
});

const store = live ? createFirestoreKgStore() : createMemoryKgStore();
__setKgStoreForTest(store);

// Populate the memory store from the bundles when running offline; --live
// trusts whatever the seed script wrote to real Firestore.
if (!live) {
  for (const { workspace, grade, subject } of listAvailableContexts()) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const model = adapter.parse(raw);
    const { nodes, edges } = serializeModel(model, kgNamespace(workspace, grade, subject));
    await store.writeSlot(kgNamespace(workspace, grade, subject), "a", {
      nodes, edges,
      meta: { contentHash: "cli", seededAt: new Date(0).toISOString(), adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length },
    });
    await store.ensurePointer(kgNamespace(workspace, grade, subject), "a");
  }
}

async function collect(source, workspace, grade, subject) {
  process.env.KG_SOURCE = source;
  const state = newSessionState();
  return runInSession(state, async () => {
    const r = await activateContext(workspace, grade, subject);
    if (!r.ok) throw new Error(`activate ${workspace}/${grade}/${subject} @ ${source}: ${r.error}`);
    const adapter = resolveAdapter(grade, subject);
    // The read surface is the generic graph read (get_course / get_standards) over
    // the parsed model's rawGraph. Snapshot node ids + the edge multiset — bundle
    // and firestore must produce the identical read graph. Mirrors the oracle in
    // src/kg-store/__tests__/parity.test.ts (the cooked per-unit projections are gone).
    const model = adapter.model();
    return {
      nodes: [...model.byId.keys()].sort(),
      edges: (model.rawGraph?.relationships ?? []).map((e) => `${e.type}|${e.start}|${e.end}`).sort(),
    };
  });
}

let failures = 0;
for (const { workspace, grade, subject } of listAvailableContexts()) {
  const label = `${workspace}/${grade}/${subject}`;
  try {
    const bundleReads = await collect("bundle", workspace, grade, subject);
    const storeReads = await collect("firestore", workspace, grade, subject);
    // Deep-strict-equal is the parity oracle. Parsed JSON, not raw strings,
    // so field-ordering differences on the way in don't produce false diffs.
    deepStrictEqual(storeReads, bundleReads);
    console.error(`parity-check: ${label}: OK — ${bundleReads.nodes.length} node(s), ${bundleReads.edges.length} edge(s) matched.`);
  } catch (e) {
    failures++;
    if (e instanceof AssertionError) {
      console.error(`parity-check: ${label}: DIFF — outputs differ between bundle and firestore backends.`);
    } else {
      console.error(`parity-check: ${label}: FAILED — ${e && e.message}`);
    }
  }
}

if (failures > 0) { console.error(`parity-check: ${failures} failure(s).`); process.exit(2); }
console.error("parity-check: all backends match.");
