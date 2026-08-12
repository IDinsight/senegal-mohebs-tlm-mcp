/*
 * Make RECE a "Composants dérivés" frame like the others (Rwanda P1 etc.)
 *
 * The other derived frames hang their illustrative Activities DIRECTLY off a
 * StandardsFrameworkItem via hasChild. RECE instead wrapped them in a content
 * Course → task-groupings → activities. This transform removes that wrapper and
 * re-homes the activities onto RECE's own leaf sub-SFIs, matching the pattern.
 *
 * Deterministic + re-runnable (bails if the RECE Course is already gone):
 *   1. Map each of the 6 RECE task-groupings ("OP — LEVEL") to RECE's matching
 *      leaf sub-SFI (LEVEL under operation OP).
 *   2. Re-point every task-grouping --hasPart--> Activity onto
 *      leaf-sub-SFI --hasChild--> Activity (Rwanda-style). Alignments
 *      (Activity --hasEducationalAlignment--> LearningComponent) are untouched, so
 *      generation is unaffected (the golden gate stays green).
 *   3. Delete the Course, the 6 task-groupings, and the now-empty
 *      "Tâches illustratives (RECE)" wrapper SFI, plus their incident edges.
 * Run: node scripts/migrate-rece-derived-components.mjs  (add --dry to preview).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = resolve(HERE, "..", "sources", "ci", "maths", "knowledge_graph.json");
const DRY = process.argv.includes("--dry");

const derivedId = (seed) => {
  const h = createHash("sha1").update(seed).digest("hex");
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const graph = JSON.parse(readFileSync(GRAPH, "utf8"));
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const lbl = (n) => n?.labels ?? [];
const stOf = (n) => n?.properties?.statementType;
const descOf = (n) => n?.properties?.description ?? "";
const childrenVia = (id, type) => graph.relationships.filter((r) => r.start === id && r.type === type).map((r) => byId.get(r.end)).filter(Boolean);

const frame = graph.nodes.find((n) => stOf(n) === "Cadre RECE");
if (!frame) { console.error("RECE frame SFI (statementType 'Cadre RECE') not found."); process.exit(1); }
const wrapper = childrenVia(frame.id, "hasChild").find((n) => stOf(n) === "Banque de tâches RECE");
if (!wrapper) { console.error("Refusing to run: 'Tâches illustratives (RECE)' wrapper SFI not found (already migrated?)."); process.exit(1); }
const course = childrenVia(wrapper.id, "hasChild").find((n) => lbl(n).includes("Course"));
if (!course) { console.error("Refusing to run: RECE Course not found under the wrapper (already migrated?)."); process.exit(1); }

// Operation SFIs (Addition/soustraction, Multiplication/division) → their leaf sub-SFIs.
const opSFIs = childrenVia(frame.id, "hasChild").filter((n) => stOf(n) === "Groupe d'opérations (RECE)");
// leaf lookup: `${op desc} — ${leaf desc}` → leaf node
const leafByKey = new Map();
for (const op of opSFIs) for (const leaf of childrenVia(op.id, "hasChild")) leafByKey.set(`${descOf(op)} — ${descOf(leaf)}`, leaf);

// Each task-grouping ("OP — LEVEL") maps to the leaf whose full key matches.
const taskGroupings = childrenVia(course.id, "hasPart").filter((n) => lbl(n).includes("LessonGrouping"));
const mapping = [];
for (const tg of taskGroupings) {
  const leaf = leafByKey.get(descOf(tg));
  if (!leaf) { console.error(`No leaf sub-SFI matches task-grouping "${descOf(tg)}". Aborting.`); process.exit(1); }
  mapping.push({ tg, leaf });
}

// 1+2. Re-point each task-grouping's Activities onto its leaf sub-SFI (hasChild).
let repointed = 0;
const newEdges = [];
for (const { tg, leaf } of mapping) {
  for (const r of graph.relationships) {
    if (r.type !== "hasPart" || r.start !== tg.id) continue;
    const child = byId.get(r.end);
    if (!child || !lbl(child).includes("Activity")) continue;
    const id = derivedId(`${leaf.id}:hasChild:${child.id}`);
    newEdges.push({
      id, type: "hasChild", start: leaf.id, end: child.id,
      properties: {
        identifier: id, relationship_type: "hasChild",
        description: "A hasChild relationship links a derived-frame item to an illustrative activity.",
        sourceEntity: "StandardsFrameworkItem", targetEntity: "Activity", targetLabels: ["Activity"],
        license: "https://creativecommons.org/licenses/by/4.0/",
      },
    });
    repointed++;
  }
}

// 3. Remove the wrapper subtree: Course + task-groupings + wrapper SFI, and every
//    edge incident to any of them (this drops the old task-grouping→Activity
//    hasPart edges, the Course→task-grouping edges, wrapper→Course, frame→wrapper).
const removeIds = new Set([course.id, wrapper.id, ...taskGroupings.map((t) => t.id)]);
const nodesBefore = graph.nodes.length, edgesBefore = graph.relationships.length;
graph.nodes = graph.nodes.filter((n) => !removeIds.has(n.id));
graph.relationships = graph.relationships.filter((r) => !removeIds.has(r.start) && !removeIds.has(r.end));
graph.relationships.push(...newEdges);

console.log(JSON.stringify({
  leafMappings: mapping.map((m) => `${descOf(m.tg)}  →  [leaf] ${descOf(m.leaf)}`),
  activitiesRepointed: repointed,
  nodesRemoved: nodesBefore - graph.nodes.length,   // Course + 6 task-groupings + wrapper SFI = 8
  edgesDelta: graph.relationships.length - edgesBefore,
  totalNodes: graph.nodes.length,
  totalEdges: graph.relationships.length,
}, null, 2));

if (DRY) { console.log("(dry run — not written)"); process.exit(0); }
writeFileSync(GRAPH, JSON.stringify(graph, null, 2) + "\n");
console.log(`Wrote ${GRAPH}`);
