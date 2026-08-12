/*
 * Illustrative activities align to a STANDARD (canonical hasEducationalAlignment)
 *
 * Illustrative activities were attached to the LearningComponent they exemplify
 * via `Activity --hasEducationalAlignment--> LearningComponent`. But canonically
 * `hasEducationalAlignment` targets a StandardsFrameworkItem only, and LC defines
 * no Activity↔LearningComponent edge at all.
 *
 * Canonical fix: point each Activity's `hasEducationalAlignment` at the STANDARD —
 * the component's (unambiguous) parent StandardsFrameworkItem — and keep the finer
 * "which component/skill" as a PROPERTY (`metadata.illustratesComponent =
 * {id, name, order}`) rather than a non-canonical edge. `order` preserves the
 * activity's position within the component so the read projection is byte-identical
 * (buildSlice groups tasks by this property instead of the old edge).
 *
 * Deterministic + re-runnable (bails if no Activity→LC alignment edges remain).
 * Run: node scripts/migrate-activity-alignment-canonical.mjs  (add --dry to preview).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = resolve(HERE, "..", "sources", "ci", "maths", "knowledge_graph.json");
const DRY = process.argv.includes("--dry");

const graph = JSON.parse(readFileSync(GRAPH, "utf8"));
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const isActivity = (id) => (byId.get(id)?.labels ?? []).includes("Activity");
const isComponent = (id) => (byId.get(id)?.labels ?? []).includes("LearningComponent");
const isSFI = (id) => (byId.get(id)?.labels ?? []).includes("StandardsFrameworkItem");

// The component's single parent StandardsFrameworkItem (the standard it belongs to).
const parentSFI = (lcId) => {
  const parents = graph.relationships.filter((r) => r.type === "hasChild" && r.end === lcId && isSFI(r.start)).map((r) => r.start);
  return parents.length === 1 ? parents[0] : null;
};

// Alignment edges to fix — in graph order, so the per-component `order` we stamp
// matches the parser's childIds order (byte-identical reads).
const targets = graph.relationships.filter((r) => r.type === "hasEducationalAlignment" && isActivity(r.start) && isComponent(r.end));
if (targets.length === 0) { console.error("Refusing to run: no Activity→LearningComponent hasEducationalAlignment edges (already migrated?)."); process.exit(1); }

const orderByComponent = new Map();  // lcId → running index
let unresolved = 0;
for (const r of targets) {
  const activityId = r.start, lcId = r.end;
  const sfi = parentSFI(lcId);
  if (!sfi) { unresolved++; continue; }
  const idx = orderByComponent.get(lcId) ?? 0;
  orderByComponent.set(lcId, idx + 1);

  // Stamp the specific-component property on the activity (metadata sidecar).
  const a = byId.get(activityId);
  const md = (a.properties.metadata ??= {});
  md.illustratesComponent = { id: lcId, name: byId.get(lcId)?.properties?.description ?? null, order: idx };

  // Re-point the alignment edge at the STANDARD (the component's parent SFI).
  r.end = sfi;
  if (r.properties) {
    r.properties.targetEntity = "StandardsFrameworkItem";
    r.properties.targetLabels = ["StandardsFrameworkItem"];
  }
}

const remaining = graph.relationships.filter((r) => r.type === "hasEducationalAlignment");
const badTargets = remaining.filter((r) => !isSFI(r.end));
console.log(JSON.stringify({
  edgesRetargeted: targets.length - unresolved,
  unresolvedNoSingleParent: unresolved,
  hasEducationalAlignmentTotal: remaining.length,
  hasEducationalAlignmentTargetingNonSFI: badTargets.length, // must be 0
  totalNodes: graph.nodes.length, totalEdges: graph.relationships.length,
}, null, 2));
if (badTargets.length || unresolved) { console.error("ABORT: some alignments unresolved or still target a non-SFI."); process.exit(1); }

if (DRY) { console.log("(dry run — not written)"); process.exit(0); }
writeFileSync(GRAPH, JSON.stringify(graph, null, 2) + "\n");
console.log(`Wrote ${GRAPH}`);
