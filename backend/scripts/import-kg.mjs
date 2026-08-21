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
 *   3. writes them to a slot with a provenance meta stamp — slot "a" for a fresh
 *      namespace, or (with --replace-published, for an EXISTING namespace) the
 *      currently-published slot IN PLACE, so a re-import lands live regardless of
 *      whether the published slot is "a" or "b". --replace-published writes only
 *      the DELTA vs the live slot (writeSlotDelta), not a full rewrite of every
 *      doc — the full rewrite is what times out (DEADLINE_EXCEEDED) over a slow
 *      link on a large graph;
 *   4. writes the subject-profile config cell — from --profile <path> ({ core,
 *      guide }) when given, else the in-repo literal for that grade/subject;
 *   5. initializes the pointer { publishedSlot, draftSlot: null } if absent
 *      (ensurePointer is a no-op on an existing pointer, so a re-import never
 *      silently moves a published draft).
 *
 * Without --replace-published a re-import writes slot "a" and leaves the pointer,
 * so if the namespace's published slot is "b" the import lands on the NON-published
 * slot and readers see nothing change. --replace-published avoids that by writing
 * the live slot directly (refused if a draft is open — publish/discard it first).
 *
 * Usage (after `npm run build`):
 *   node scripts/import-kg.mjs <workspace> <grade> <subject> <graph.json> [--profile p.json] [--replace-published] [--dry-run]
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
const replacePublished = args.includes("--replace-published");
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

// Stable JSON (keys sorted recursively) so property-ORDER differences between a
// freshly-serialized doc and its stored copy don't read as content changes.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",")}}`;
  }
  return JSON.stringify(v);
}

// Content fingerprint of a stored doc, IGNORING the `slot` stamp (it's re-stamped
// on write). Everything else — id, type, labels, spine, properties, edge seq — is
// load-bearing, so any change there is a real change.
function fingerprint(doc) {
  const { slot, ...rest } = doc;
  return stableStringify(rest);
}

// Diff the desired graph against the slot's current contents → the minimal
// SlotDelta. Ids are the identity: an id whose fingerprint changed (or is new) is
// an upsert; an id present live but absent now is a delete. A spurious mismatch
// only ever costs an extra (identical) upsert — it can never corrupt the result.
function computeDelta(curNodes, curEdges, nextNodes, nextEdges) {
  const upserts = (cur, next) => {
    const liveFp = new Map(cur.map((d) => [d.id, fingerprint(d)]));
    return next.filter((d) => liveFp.get(d.id) !== fingerprint(d));
  };
  const removals = (cur, next) => {
    const keep = new Set(next.map((d) => d.id));
    return cur.filter((d) => !keep.has(d.id)).map((d) => d.id);
  };
  return {
    upsertNodes: upserts(curNodes, nextNodes),
    upsertEdges: upserts(curEdges, nextEdges),
    removeNodeIds: removals(curNodes, nextNodes),
    removeEdgeIds: removals(curEdges, nextEdges),
  };
}

const adapter = resolveAdapter(workspace, grade, subject);
if (!adapter) {
  console.error(`import-kg: no subject adapter registered for '${workspace}/${grade}/${subject}'. Add its profile under src/adapters/profiles/ first.`);
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
  const core = getRegisteredProfile(workspace, grade, subject);
  const guide = getRegisteredGuide(workspace, grade, subject);
  config = guide !== undefined ? { core, guide } : { core };
}

const store = dryRun ? createMemoryKgStore() : createFirestoreKgStore();
console.error(`import-kg: backend=${store.kind}, ns='${namespace}', nodes=${nodes.length}, edges=${edges.length}, hash=${contentHash.slice(0, 12)}…`);

try {
  const existing = await store.readPointer(namespace);
  // Fresh namespace → slot "a". Existing namespace → slot "a" (the old default,
  // which lands on the non-published slot when published is "b"), UNLESS
  // --replace-published, which writes the live published slot in place.
  let targetSlot = "a";
  if (existing) {
    if (replacePublished) {
      if (existing.draftSlot) {
        console.error(`import-kg: REFUSING --replace-published — a draft is open on '${namespace}' (draftSlot='${existing.draftSlot}'). Publish or discard it first.`);
        process.exit(2);
      }
      targetSlot = existing.publishedSlot;
      console.error(`import-kg: --replace-published → overwriting the LIVE published slot '${targetSlot}' in place.`);
    } else {
      console.error(`import-kg: WARNING — namespace '${namespace}' already exists (publishedSlot='${existing.publishedSlot}'); writing slot 'a' and leaving the pointer as-is. Pass --replace-published to update the live graph instead.`);
    }
  }

  if (existing && replacePublished) {
    // O(delta) in-place replace: read the live slot, diff, and write ONLY what
    // changed. writeSlot rewrites every doc (~nodes+edges writes), which is what
    // times out (DEADLINE_EXCEEDED) over a slow link on a large re-import; a
    // re-import of a mostly-unchanged graph now costs a few hundred writes.
    const [curNodes, curEdges] = await Promise.all([
      store.listNodes(namespace, targetSlot),
      store.listEdges(namespace, targetSlot),
    ]);
    const delta = computeDelta(curNodes, curEdges, nodes, edges);
    console.error(
      `import-kg: delta vs live slot '${targetSlot}' — nodes ${delta.upsertNodes.length} upsert / ${delta.removeNodeIds.length} delete, ` +
      `edges ${delta.upsertEdges.length} upsert / ${delta.removeEdgeIds.length} delete (live had ${curNodes.length} nodes / ${curEdges.length} edges).`,
    );
    await store.writeSlotDelta(namespace, targetSlot, delta, meta);
  } else {
    // Fresh namespace (or the non-replace slot-'a' path): nothing to diff against,
    // so write the whole slot.
    await store.writeSlot(namespace, targetSlot, { nodes, edges, meta });
  }
  if (config?.core) await store.writeConfig(namespace, targetSlot, config);
  await store.ensurePointer(namespace, targetSlot);
  console.error("import-kg: done.");
} catch (e) {
  console.error(`import-kg: FAILED — ${(e && e.message) || e}`);
  process.exit(2);
}
