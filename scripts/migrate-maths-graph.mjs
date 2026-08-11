// ── One-shot migration: split lesson↔expectation, chapter→LessonGrouping ─────
// Graph-native-authoring migration (docs/design-notes/graph-native-authoring.md),
// maths only. Reads sources/ci/maths/knowledge_graph.json and rewrites it into
// the split topology, in the graph's EXISTING serialization convention
// (Curriculum/StandardsFrameworkItem labels, hasChild/supports edges, snake_case).
//
// What it does, mechanically and losslessly (1:1 with today):
//   1. Each `subtopic` (Chapitre) SFI is converted IN PLACE to a content
//      LessonGrouping: labels → ["LessonGrouping"], normalized_type added. Its
//      id, order, title, buildsTowards edges, and statement_type stay, so
//      progression / detect() / listUnits are unaffected.
//   2. Per expectation (role "expectation" | "intégration du palier") we mint a
//      content `Lesson` node, then RE-POINT every hasChild edge whose end is that
//      expectation (its chapter edge AND its week edge — the two-axis pattern now
//      rides the Lesson) and add `Lesson --supports--> expectation` (coverage).
//   3. The expectation stays on the spine with its components/tasks untouched.
//
// Idempotent-ish: refuses to run twice (bails if any Lesson-labelled node exists).
// Run: node scripts/migrate-maths-graph.mjs   (add --dry to preview counts only)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = resolve(HERE, "..", "sources", "ci", "maths", "knowledge_graph.json");
const DRY = process.argv.includes("--dry");

const EXPECTATION_ROLES = new Set(["expectation", "intégration du palier"]);
const SUBTOPIC_ROLE = "subtopic";

// Deterministic UUID-shaped id from a seed, so re-running the script produces the
// same ids (no Math.random) and the committed JSON is stable.
function derivedId(seed) {
  const h = createHash("sha1").update(seed).digest("hex");
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16); // RFC-4122 variant nibble
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const graph = JSON.parse(readFileSync(GRAPH, "utf8"));
const nodes = graph.nodes;
const rels = graph.relationships;

if (nodes.some((n) => (n.labels ?? []).includes("Lesson"))) {
  console.error("Refusing to run: graph already has Lesson-labelled nodes (already migrated?).");
  process.exit(1);
}

const roleOf = (n) => n.properties?.metadata?.role ?? null;
const isExpectation = (n) => EXPECTATION_ROLES.has(roleOf(n));
const isSubtopic = (n) => roleOf(n) === SUBTOPIC_ROLE;

// 1. Convert subtopics (Chapitre) → content LessonGrouping, in place.
let chaptersConverted = 0;
for (const n of nodes) {
  if (!isSubtopic(n)) continue;
  n.labels = ["LessonGrouping"];
  n.properties.normalized_type = "Lesson Grouping"; // content-layer marker (parser reads statement type, not this)
  // LC-native grouping type + level. group_name is the authoritative type
  // ("Chapitre" here; a future grouping could be "Unité"/"Module"); statement_type
  // is kept as a legacy mirror. group_level is its position in the series.
  n.properties.group_name = "Chapitre";
  n.properties.group_level = n.properties?.metadata?.order ?? null;
  chaptersConverted++;
}

// 2. Mint a Lesson node per expectation; index expectation id → Lesson id.
const lessonForExp = new Map();
const newLessonNodes = [];
for (const n of nodes) {
  if (!isExpectation(n)) continue;
  const p = n.properties ?? {};
  const lid = derivedId(`${n.id}:lesson`);
  lessonForExp.set(n.id, lid);
  newLessonNodes.push({
    id: lid,
    labels: ["Lesson"],
    properties: {
      identifier: lid,
      normalized_type: "Lesson",
      // description doubles as the lesson's human title; substantive prose will
      // live on attached Material nodes (authoring phase), not here.
      description: p.description ?? null,
      metadata: { order: p.metadata?.order ?? null }, // parser reads leconNum from metadata.order
      // palier is a scheduling tier the week borrows for the planning view; a
      // denormalized copy of the aligned expectation's (all a week's lessons share it).
      ...(p.palier != null ? { palier: p.palier } : {}),
      in_language: p.in_language ?? "fr-FR",
      academic_subject: p.academic_subject ?? "Mathematics",
      license: p.license ?? "https://creativecommons.org/licenses/by/4.0/",
      attribution_statement: p.attribution_statement ?? "",
      provider: p.provider ?? "Learning Commons ontology (generated)",
    },
  });
}

// 3. Re-point every hasChild edge whose END is an expectation onto its Lesson,
//    so both the chapter axis and the week axis now point at the Lesson.
let repointed = 0;
for (const r of rels) {
  if (r.type !== "hasChild") continue;
  const lid = lessonForExp.get(r.end);
  if (!lid) continue;
  r.end = lid;
  if (r.properties) { r.properties.target_labels = ["Lesson"]; r.properties.target_entity = "Lesson"; }
  repointed++;
}

// 4. Add Lesson --supports--> expectation (coverage / alignment).
const newSupportEdges = [];
for (const [expId, lid] of lessonForExp) {
  const id = derivedId(`${lid}:supports:${expId}`);
  newSupportEdges.push({
    id,
    type: "supports",
    start: lid,
    end: expId,
    properties: {
      identifier: id,
      relationship_type: "supports",
      source_labels: ["Lesson"], source_entity: "Lesson", source_entity_key: "identifier",
      target_labels: ["StandardsFrameworkItem"], target_entity: "StandardsFrameworkItem", target_entity_key: "identifier",
      license: "https://creativecommons.org/licenses/by/4.0/",
    },
  });
}

nodes.push(...newLessonNodes);
rels.push(...newSupportEdges);

console.log(JSON.stringify({
  chaptersConverted,
  lessonsMinted: newLessonNodes.length,
  hasChildEdgesRepointed: repointed,
  supportsEdgesAdded: newSupportEdges.length,
  totalNodes: nodes.length,
  totalRels: rels.length,
}, null, 2));

if (DRY) { console.log("(dry run — not written)"); process.exit(0); }
writeFileSync(GRAPH, JSON.stringify(graph, null, 2) + "\n");
console.log(`Wrote ${GRAPH}`);
