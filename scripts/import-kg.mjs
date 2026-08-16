#!/usr/bin/env node
/*
 * Import a knowledge graph into the Firestore KG store — the on-demand way to
 * add a new (workspace, grade, subject), replacing the old sources/-scanning
 * seed (the KG lives only in the store now; see
 * docs/design-notes/firestore-only-store.md).
 *
 * Given a raw Learning-Commons envelope JSON ({ nodes, relationships }), this:
 *   1. parses it with the subject adapter → normalized CurriculumModel;
 *   2. serializes to generic StoredNode/StoredEdge docs (ids verbatim);
 *   3. writes them to slot "a" with a provenance meta stamp;
 *   4. writes the subject-profile config cell — from --profile <path> ({ core,
 *      guide }) when given, else the in-repo literal for that grade/subject;
 *   5. initializes the pointer { publishedSlot: "a", draftSlot: null } if absent
 *      (ensurePointer is a no-op on an existing pointer, so a re-import never
 *      silently moves a published draft back to "a").
 *
 * Usage (after `npm run build`):
 *   node scripts/import-kg.mjs <workspace> <grade> <subject> <graph.json> [--profile p.json] [--dry-run]
 *
 * Env (same as the server): SERVICE_ACCOUNT_KEY_PATH (or SERVICE_ACCOUNT_KEY_JSON),
 * FIREBASE_STORAGE_BUCKET, TLM_BUCKET_PREFIX (match the runtime prefix so the
 * namespace lines up). --dry-run uses an in-memory store and writes nothing.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO, "dist"))) {
  console.error("import-kg: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { resolveAdapter, getRegisteredProfile, getRegisteredGuide } = await import(new URL("../dist/adapters/index.js", import.meta.url));
const { serializeModel } = await import(new URL("../dist/curriculum/index.js", import.meta.url));
const { kgNamespace, createMemoryKgStore, createFirestoreKgStore } = await import(new URL("../dist/kg-store/index.js", import.meta.url));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const profileIdx = args.indexOf("--profile");
const profilePath = profileIdx >= 0 ? args[profileIdx + 1] : null;
// Drop the value after --profile, but only when the flag is present (indexOf
// returns -1 when absent, and -1 + 1 = 0 would wrongly drop the first positional).
const positional = args.filter((a, i) => !a.startsWith("--") && (profileIdx < 0 || i !== profileIdx + 1));

if (positional.length !== 4) {
  console.error("import-kg: expected `<workspace> <grade> <subject> <graph.json>` (plus optional --profile <path> / --dry-run).");
  process.exit(1);
}
const [workspace, grade, subject, graphPath] = positional;

const adapter = resolveAdapter(grade, subject);
if (!adapter) {
  console.error(`import-kg: no subject adapter registered for '${grade}/${subject}'. Add its profile under src/adapters/profiles/ first.`);
  process.exit(1);
}

const rawBytes = readFileSync(resolve(graphPath));
const contentHash = createHash("sha256").update(rawBytes).digest("hex");
const model = adapter.parse(JSON.parse(rawBytes.toString("utf8")));
const namespace = kgNamespace(workspace, grade, subject);
const { nodes, edges } = serializeModel(model, namespace);
const meta = { contentHash, seededAt: new Date().toISOString(), adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };

// The profile config cell: an explicit --profile file wins; otherwise the
// in-repo { core, guide } literal for this grade/subject.
let config;
if (profilePath) {
  config = JSON.parse(readFileSync(resolve(profilePath), "utf8"));
} else {
  const core = getRegisteredProfile(grade, subject);
  const guide = getRegisteredGuide(grade, subject);
  config = guide !== undefined ? { core, guide } : { core };
}

const store = dryRun ? createMemoryKgStore() : createFirestoreKgStore();
console.error(`import-kg: backend=${store.kind}, ns='${namespace}', nodes=${nodes.length}, edges=${edges.length}, hash=${contentHash.slice(0, 12)}…`);

try {
  const existing = await store.readPointer(namespace);
  if (existing) console.error(`import-kg: WARNING — namespace '${namespace}' already exists (publishedSlot='${existing.publishedSlot}'); writing slot 'a' and leaving the pointer as-is.`);
  await store.writeSlot(namespace, "a", { nodes, edges, meta });
  if (config?.core) await store.writeConfig(namespace, "a", config);
  await store.ensurePointer(namespace, "a");
  console.error("import-kg: done.");
} catch (e) {
  console.error(`import-kg: FAILED — ${(e && e.message) || e}`);
  process.exit(2);
}
