// ── Fix the Activity→LearningComponent edge (canonical hygiene) ──────────────
// Illustrative activities were attached to the component they exemplify via
// `Activity --hasEducationalAlignment--> LearningComponent`. But canonically
// `hasEducationalAlignment` targets a StandardsFrameworkItem only, and LC defines
// no Activity↔LearningComponent edge at all — so this was a shoehorn. The
// relationship (a component's illustrative tasks) is real and load-bearing:
// buildSlice surfaces a lesson's tasks by walking component → its activities.
//
// Fix: re-type + reverse to `LearningComponent --hasChild--> Activity` (the
// component CONTAINS its illustrative tasks). buildSlice still reaches the tasks
// (childrenOf(component) via containment), so reads/generation are unchanged
// (golden gate stays green); `hasEducationalAlignment` is no longer pointed at a
// non-SFI. Only Lesson→SFI hasEducationalAlignment edges remain (correct).
//
// Deterministic + re-runnable (bails if no Activity→LC alignment edges remain).
// Run: node scripts/migrate-activity-component-edge.mjs  (add --dry to preview).
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
const isActivity = (id) => (byId.get(id)?.labels ?? []).includes("Activity");
const isComponent = (id) => (byId.get(id)?.labels ?? []).includes("LearningComponent");

const targets = graph.relationships.filter(
  (r) => r.type === "hasEducationalAlignment" && isActivity(r.start) && isComponent(r.end),
);
if (targets.length === 0) {
  console.error("Refusing to run: no Activity→LearningComponent hasEducationalAlignment edges (already migrated?).");
  process.exit(1);
}

// Sanity: no hasEducationalAlignment should target a component after this; the
// only legitimate ones (Lesson/Activity→SFI) target StandardsFrameworkItems.
let retyped = 0;
for (const r of targets) {
  const lc = r.end, activity = r.start;
  const id = derivedId(`${lc}:hasChild:${activity}`);
  r.id = id;
  r.type = "hasChild";
  r.start = lc;        // component is the parent (container)
  r.end = activity;    // activity is the child (illustrative task)
  r.properties = {
    identifier: id,
    relationship_type: "hasChild",
    description: "A hasChild relationship links a learning component to an illustrative activity that exemplifies it.",
    sourceEntity: "LearningComponent", sourceEntityKey: "identifier",
    targetEntity: "Activity", targetEntityKey: "identifier", targetLabels: ["Activity"],
    license: "https://creativecommons.org/licenses/by/4.0/",
  };
  retyped++;
}

const remaining = graph.relationships.filter((r) => r.type === "hasEducationalAlignment");
const badTargets = remaining.filter((r) => !(byId.get(r.end)?.labels ?? []).includes("StandardsFrameworkItem"));
console.log(JSON.stringify({
  edgesRetyped: retyped,
  hasEducationalAlignmentRemaining: remaining.length,             // Lesson→SFI (should all target SFIs)
  hasEducationalAlignmentTargetingNonSFI: badTargets.length,      // must be 0
  totalNodes: graph.nodes.length,
  totalEdges: graph.relationships.length,
}, null, 2));
if (badTargets.length) { console.error("ABORT: hasEducationalAlignment still targets a non-SFI."); process.exit(1); }

if (DRY) { console.log("(dry run — not written)"); process.exit(0); }
writeFileSync(GRAPH, JSON.stringify(graph, null, 2) + "\n");
console.log(`Wrote ${GRAPH}`);
