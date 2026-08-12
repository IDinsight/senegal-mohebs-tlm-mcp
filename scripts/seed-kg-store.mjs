#!/usr/bin/env node
/*
 * Idempotent seed for the Firestore-backed KG node/edge store.
 *
 * For each installed grade/subject folder, this script:
 *   1. Reads the bundled knowledge_graph.json.
 *   2. Runs the subject adapter (detect + parse) to produce a
 *      normalized CurriculumModel.
 *   3. Serializes to generic StoredNode/StoredEdge documents with verbatim
 *      ids (UUIDs and integer scopes are never regenerated).
 *   4. Writes the batch to Firestore under namespace `${prefix}<grade>/<subject>`,
 *      slot "a" — the seed always populates the "a" slot; a curator's draft (if
 *      one exists) sits in "b" and is left untouched.
 *   5. Stamps a per-namespace pointer doc { publishedSlot: "a", draftSlot: null }
 *      the first time only — a re-seed does NOT reset the pointer, so publishing
 *      a draft (which flips publishedSlot to "b") remains sticky. Once flipped,
 *      a re-seed of "a" is effectively writing to a stale/discarded slot; the
 *      operator should reconcile deliberately (see README).
 *   6. Includes the raw content hash + adapter id + wall-clock time on the
 *      per-slot meta stamp so the seed is traceable.
 *
 * Usage:
 *   npm run build                             # compile TS to dist/ first
 *   node scripts/seed-kg-store.mjs            # seed every installed context
 *   node scripts/seed-kg-store.mjs ci maths   # seed a single context
 *   node scripts/seed-kg-store.mjs --dry-run  # use an in-memory store; no writes
 *
 * Env (same as the server):
 *   SERVICE_ACCOUNT_KEY_PATH (or SERVICE_ACCOUNT_KEY_JSON) — Firebase auth
 *   FIREBASE_STORAGE_BUCKET — required for Firestore's app init to succeed
 *   TLM_SOURCES_DIR — override the sources root
 *   TLM_BUCKET_PREFIX — kept identical to the runtime prefix so namespaces line up
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(REPO, "dist");
if (!existsSync(DIST)) {
  console.error("seed-kg-store: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { CONFIG } = await import(new URL("../dist/config.js", import.meta.url));
const { listAvailableContexts, subjectDir } = await import(new URL("../dist/context/index.js", import.meta.url));
const { resolveAdapter } = await import(new URL("../dist/adapters/index.js", import.meta.url));
const { serializeModel } = await import(new URL("../dist/curriculum/index.js", import.meta.url));
const { kgNamespace, createMemoryKgStore, createFirestoreKgStore } = await import(new URL("../dist/kg-store/index.js", import.meta.url));

// ── Argument parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const targetPair = positional.length === 2 ? { grade: positional[0], subject: positional[1] } : null;
if (positional.length !== 0 && positional.length !== 2) {
  console.error("seed-kg-store: expected either no positional args or `<grade> <subject>`.");
  process.exit(1);
}

const available = listAvailableContexts();
const pairs = targetPair
  ? available.filter((c) => c.grade === targetPair.grade && c.subject === targetPair.subject)
  : available;

if (pairs.length === 0) {
  console.error(`seed-kg-store: no matching grade/subject sources under ${CONFIG.sourcesDir}.`);
  process.exit(1);
}

const store = dryRun ? createMemoryKgStore() : createFirestoreKgStore();
console.error(`seed-kg-store: backend=${store.kind}, sources=${CONFIG.sourcesDir}, ${pairs.length} pair(s).`);

let failures = 0;
for (const { grade, subject } of pairs) {
  const label = `${grade}/${subject}`;
  const bundlePath = resolve(subjectDir(grade, subject), CONFIG.kgFile);
  if (!existsSync(bundlePath)) {
    console.error(`seed-kg-store: ${label}: no ${CONFIG.kgFile} at ${bundlePath} — skipped.`);
    failures++;
    continue;
  }

  // Read RAW bytes for the content hash (the seed's provenance stamp) so the
  // hash is stable regardless of any downstream re-serialization.
  const rawBytes = readFileSync(bundlePath);
  const contentHash = createHash("sha256").update(rawBytes).digest("hex");
  const parsed = JSON.parse(rawBytes.toString("utf8"));

  const adapter = resolveAdapter(grade, subject);
  if (!adapter) {
    console.error(`seed-kg-store: ${label}: no subject adapter registered — skipped.`);
    failures++;
    continue;
  }
  if (!adapter.detect(parsed)) {
    console.error(`seed-kg-store: ${label}: adapter refused this graph — skipped.`);
    failures++;
    continue;
  }

  const model = adapter.parse(parsed);
  const namespace = kgNamespace(grade, subject);
  const { nodes, edges } = serializeModel(model, namespace);
  const meta = {
    contentHash,
    seededAt: new Date().toISOString(),
    adapterId: adapter.id,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };

  try {
    // Always seed into slot "a". The pointer is only initialized the first
    // time (ensurePointer is a no-op if one already exists), so re-seeding
    // after a curator has published a draft (which put "b" into publishedSlot)
    // does NOT silently move published back to "a" — the pointer stays put and
    // slot "a" becomes a stale side copy. Flag that state to the operator.
    const existingPointer = await store.readPointer(namespace);
    await store.writeSlot(namespace, "a", { nodes, edges, meta });
    await store.ensurePointer(namespace, "a");
    const afterPointer = await store.readPointer(namespace);
    const note = existingPointer && afterPointer && afterPointer.publishedSlot !== "a"
      ? ` (WARNING: publishedSlot is currently '${afterPointer.publishedSlot}', not 'a' — this re-seed wrote to a non-published slot)`
      : afterPointer && afterPointer.draftSlot === "a"
        ? ` (WARNING: slot 'a' was the active draft — this re-seed overwrote it)`
        : "";
    console.error(`seed-kg-store: ${label}: OK — ns='${namespace}', slot='a', nodes=${nodes.length}, edges=${edges.length}, hash=${contentHash.slice(0, 12)}…${note}`);
  } catch (e) {
    console.error(`seed-kg-store: ${label}: FAILED — ${(e && e.message) || e}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`seed-kg-store: done with ${failures} failure(s).`);
  process.exit(2);
}
console.error("seed-kg-store: done.");
