/*
 * Delete an ORPHANED KG namespace from Firestore — its nodes, edges, and pointer
 * across both slots. Used to clean up after a namespace rename (e.g. the
 * workspaces migration: ci/maths → senegal/ci/maths). See
 * docs/design-notes/workspaces.md.
 *
 * SAFETY:
 *   - Dry-run by DEFAULT. Pass --confirm to actually delete.
 *   - REFUSES to delete a namespace that is still installed in sources/ (so a
 *     live namespace like senegal/ci/maths can never be removed by this script).
 *   - Leaves kg_audit UNTOUCHED — the audit trail is append-only history and is
 *     kept even for a retired namespace.
 *
 * Prereqs (same as the seed): SERVICE_ACCOUNT_KEY_PATH (or _JSON),
 * FIREBASE_STORAGE_BUCKET. Build first (reads dist/ for the safety guard).
 *
 * Usage:
 *   node scripts/delete-namespace.mjs                      # dry-run, default targets
 *   node scripts/delete-namespace.mjs --confirm            # delete default targets
 *   node scripts/delete-namespace.mjs ci/maths --confirm   # one explicit namespace
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ── Firebase init (mirrors src/kg-store/firestore.ts) ────────────────────────
const fbApp = require("firebase-admin/app");
const fbFs = require("firebase-admin/firestore");
function initFirebase() {
  if (fbApp.getApps().length > 0) return;
  const keyPath = process.env.SERVICE_ACCOUNT_KEY_PATH;
  const keyJson = process.env.SERVICE_ACCOUNT_KEY_JSON;
  const credential = keyPath
    ? fbApp.cert(keyPath)
    : keyJson
      ? fbApp.cert(JSON.parse(keyJson))
      : fbApp.applicationDefault();
  fbApp.initializeApp({ credential, storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined });
}

const NODES = "kg_nodes";
const EDGES = "kg_edges";
const POINTERS = "kg_pointers";
const nsSlug = (ns) => ns.replace(/\//g, "__");
const BATCH_MAX = 450;

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const explicit = args.filter((a) => !a.startsWith("--"));
// Default targets = the pre-workspaces namespaces retired by the migration.
const targets = explicit.length > 0 ? explicit : ["ci/maths", "ce1/reading"];

// ── Safety guard: never delete a namespace still installed in sources/ ────────
const { listAvailableContexts } = await import(new URL("../dist/context/index.js", import.meta.url));
const { kgNamespace } = await import(new URL("../dist/kg-store/index.js", import.meta.url));
const installed = new Set(listAvailableContexts().map((c) => kgNamespace(c.workspace, c.grade, c.subject)));
for (const ns of targets) {
  if (installed.has(ns)) {
    console.error(`delete-namespace: REFUSING to delete '${ns}' — it is a live, installed namespace. Aborting.`);
    process.exit(1);
  }
}

initFirebase();
const db = fbFs.getFirestore();

async function deleteRefsInChunks(refs) {
  for (let i = 0; i < refs.length; i += BATCH_MAX) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + BATCH_MAX)) batch.delete(ref);
    await batch.commit();
  }
}

console.error(`delete-namespace: ${confirm ? "DELETE" : "DRY-RUN"} — targets: ${targets.join(", ")}`);
console.error("delete-namespace: kg_audit is left untouched (append-only history).");

for (const ns of targets) {
  const [nodesSnap, edgesSnap, pointerDoc] = await Promise.all([
    db.collection(NODES).where("namespace", "==", ns).get(),
    db.collection(EDGES).where("namespace", "==", ns).get(),
    db.collection(POINTERS).doc(nsSlug(ns)).get(),
  ]);
  const nodeCount = nodesSnap.size;
  const edgeCount = edgesSnap.size;
  const hasPointer = pointerDoc.exists;
  if (nodeCount === 0 && edgeCount === 0 && !hasPointer) {
    console.error(`delete-namespace: '${ns}': nothing found (already clean).`);
    continue;
  }
  console.error(`delete-namespace: '${ns}': ${nodeCount} node(s), ${edgeCount} edge(s), pointer=${hasPointer}${confirm ? " → deleting…" : " (dry-run)"}`);
  if (!confirm) continue;
  await deleteRefsInChunks(nodesSnap.docs.map((d) => d.ref));
  await deleteRefsInChunks(edgesSnap.docs.map((d) => d.ref));
  if (hasPointer) await db.collection(POINTERS).doc(nsSlug(ns)).delete();
  console.error(`delete-namespace: '${ns}': done.`);
}

console.error(confirm ? "delete-namespace: complete." : "delete-namespace: dry-run only — re-run with --confirm to delete.");
