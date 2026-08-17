#!/usr/bin/env node
/*
 * Measure where an `add_nodes` confirm spends its wall-clock against the LIVE
 * Firestore store. It reconstructs the exact confirm sequence from
 * kg-store/mutations.ts (readBase → createDraft → re-read → apply → diff → hash
 * → writeSlot) by calling the store methods directly, timing each phase.
 *
 * SAFETY — this stages a draft on the live namespace and DISCARDS it at the end.
 *   • It NEVER publishes: generation reads the published slot, which is untouched.
 *   • It ABORTS a namespace that already has an OPEN draft, so it can't clobber
 *     someone's in-progress edit.
 *   • --keep leaves the staged draft in place (default: discard).
 * The store methods are TLM_TIMING-instrumented, so this also prints the
 * per-slice breakdown (node copies, edge upserts, …) inside createDraft/writeSlot.
 *
 * Usage (after `npm run build`, with live creds in the env — same as import-kg):
 *   node scripts/time-add-nodes.mjs <workspace> <grade> <subject> [--batch N] [--keep]
 *   node scripts/time-add-nodes.mjs --list          # just list live namespaces
 *
 * Network caveat: run locally, latency is local→Firestore, not Cloud-Run→
 * Firestore. The PHASE BREAKDOWN (which phase dominates) is what transfers;
 * absolute ms will differ from production.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Turn on the in-code phase timing before any instrumented module runs.
process.env.TLM_TIMING = "1";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO, "dist"))) {
  console.error("time-add-nodes: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { createFirestoreKgStore, kgNamespace, mintNodeId, diffGraphs } = await import(new URL("../dist/kg-store/index.js", import.meta.url));
const { hashGraph, stripSlot } = await import(new URL("../dist/kg-store/mutations.js", import.meta.url));
const { addNodes } = await import(new URL("../dist/kg-recipes/index.js", import.meta.url));

const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");
const keep = argv.includes("--keep");
const batchIdx = argv.indexOf("--batch");
const batch = batchIdx >= 0 ? Math.max(1, Number(argv[batchIdx + 1]) || 5) : 5;
const positional = argv.filter((a, i) => !a.startsWith("--") && (batchIdx < 0 || i !== batchIdx + 1));

const store = createFirestoreKgStore();

if (listOnly) {
  const namespaces = await store.listNamespaces();
  console.error(`Live namespaces (${namespaces.length}):`);
  for (const ns of namespaces) console.error(`  ${ns}`);
  process.exit(0);
}

if (positional.length !== 3) {
  console.error("time-add-nodes: expected `<workspace> <grade> <subject>` (or --list).");
  process.exit(1);
}
const [workspace, grade, subject] = positional;
const namespace = kgNamespace(workspace, grade, subject);

// Wall-clock a phase and record it in `phases` for the final summary table.
const phases = [];
async function phase(label, fn) {
  const t0 = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t0);
  phases.push({ label, ms });
  return out;
}

// Find a real (parentId, label) to add under: pick any content-containment
// edge (hasPart) and reuse its child's label + its parent. That guarantees an
// existing same-label node for deriveTemplate to copy and a valid existing parent.
function pickTarget(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (e.type !== "hasPart") continue;
    const child = byId.get(e.to);
    const label = child?.labels?.[0];
    if (child && label && !child.labels.includes("StandardsFrameworkItem")) {
      return { parentId: e.from, label };
    }
  }
  return null;
}

function makeItems(parentId, label, n) {
  return Array.from({ length: n }, (_, i) => ({
    label,
    parentId,
    newNodeId: mintNodeId(),
    title: `[timing-probe] ephemeral node ${i + 1} — discard me`,
  }));
}

const auditRec = (eventType) => ({
  id: randomUUID(),
  ts: new Date().toISOString(),
  actor: { kind: "unknown" },
  namespace,
  eventType,
});

const metaFor = (graph) => ({
  adapterId: "timing-probe",
  seededAt: "timing-probe",
  contentHash: hashGraph(graph),
  nodeCount: graph.nodes.length,
  edgeCount: graph.edges.length,
});

// Turn a before→after diff into the SlotDelta shape applyDelta consumes — the
// same conversion runGraphMutation does on the confirm path.
function toDelta(before, after) {
  const d = diffGraphs(before, after);
  const nById = new Map(after.nodes.map((n) => [n.id, n]));
  const eById = new Map(after.edges.map((e) => [e.id, e]));
  const pick = (entries, m) => entries.map((x) => m.get(x.id)).filter(Boolean);
  return {
    upsertNodes: pick([...d.nodes.added, ...d.nodes.changed], nById),
    upsertEdges: pick([...d.edges.added, ...d.edges.changed], eById),
    removeNodeIds: d.nodes.removed.map((x) => x.id),
    removeEdgeIds: d.edges.removed.map((x) => x.id),
  };
}

async function main() {
  console.error(`\n=== timing add_nodes on '${namespace}' (batch=${batch}) ===`);

  const pointer = await store.readPointer(namespace);
  if (!pointer) { console.error(`No pointer for '${namespace}' — is it seeded? Try --list.`); process.exit(1); }
  if (pointer.draftSlot) {
    console.error(`ABORT: '${namespace}' already has an OPEN draft (slot ${pointer.draftSlot}). ` +
      `Refusing to touch it. Publish or discard that draft first, then re-run.`);
    process.exit(1);
  }
  const publishedSlot = pointer.publishedSlot;

  // ── Phase 1: read the published graph (what readBase does, per slot) ──────
  const [pubNodes, pubEdges] = await phase("readPublished (nodes+edges)", () =>
    Promise.all([store.listNodes(namespace, publishedSlot), store.listEdges(namespace, publishedSlot)]));
  const base = { nodes: pubNodes.map(stripSlot), edges: pubEdges.map(stripSlot) };
  console.error(`  graph size: ${base.nodes.length} nodes, ${base.edges.length} edges`);

  await phase("hashGraph(base)", async () => hashGraph(base));

  const target = pickTarget(base.nodes, base.edges);
  if (!target) { console.error("Could not find a hasPart parent to add under — aborting."); process.exit(1); }
  console.error(`  adding ${batch} '${target.label}' node(s) under parent ${target.parentId}`);
  const args1 = { namespace, items: makeItems(target.parentId, target.label, batch) };

  // ── Phase 2: FIRST edit — createDraft (full copy) is paid here ────────────
  await phase("createDraft (full-graph copy)", () => store.createDraft(namespace, auditRec("createDraft"), base));
  const draftSlot = (await store.readPointer(namespace)).draftSlot;

  const [dn, de] = await phase("reReadDraft (nodes+edges)", () =>
    Promise.all([store.listNodes(namespace, draftSlot), store.listEdges(namespace, draftSlot)]));
  const draftGraph = { nodes: dn.map(stripSlot), edges: de.map(stripSlot) };

  const applied1 = await phase("applyFold (in-memory)", async () => addNodes.apply(draftGraph, args1));
  await phase("diffGraphs", async () => diffGraphs(draftGraph, applied1));
  await phase("hashGraph(applied)", async () => hashGraph(applied1));
  await phase("applyDelta #1 (first edit, delta only)", () =>
    store.applyDelta(namespace, draftSlot, toDelta(draftGraph, applied1), metaFor(applied1), auditRec("apply")));

  // ── Phase 3: SECOND edit on the SAME open draft — NO createDraft this time.
  // This is the asymmetry: a follow-up edit skips the full-graph copy entirely.
  const args2 = { namespace, items: makeItems(target.parentId, target.label, batch) };
  const applied2 = addNodes.apply(applied1, args2);
  await phase("applyDelta #2 (second edit, delta only, NO createDraft)", () =>
    store.applyDelta(namespace, draftSlot, toDelta(applied1, applied2), metaFor(applied2), auditRec("apply")));

  // ── Cleanup: discard the staged draft (published slot never changed) ──────
  if (keep) {
    console.error(`\n  --keep set: leaving draft slot ${draftSlot} in place. Discard it manually when done.`);
  } else {
    await phase("discardDraft (cleanup)", () => store.discardDraft(namespace, auditRec("discardDraft")));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const pad = Math.max(...phases.map((p) => p.label.length));
  console.error(`\n--- phase summary (${namespace}) ---`);
  for (const p of phases) console.error(`  ${p.label.padEnd(pad)}  ${String(p.ms).padStart(7)} ms`);
  const firstEdit = phases.filter((p) => /readPublished|hashGraph\(base\)|createDraft|reReadDraft|applyFold|diffGraphs|hashGraph\(applied\)|applyDelta #1/.test(p.label)).reduce((s, p) => s + p.ms, 0);
  const secondEditWrite = phases.find((p) => /applyDelta #2/.test(p.label))?.ms ?? 0;
  console.error(`\n  first edit (incl. createDraft): ~${firstEdit} ms`);
  console.error(`  a follow-up edit (writeSlot only): ~${secondEditWrite} ms`);
}

main().then(() => process.exit(0)).catch((err) => { console.error("time-add-nodes failed:", err); process.exit(1); });
