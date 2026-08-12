/*
 * Reading content-layer migration (graph-native authoring, Scope A)
 *
 * CE1 reading, maths-parallel and LOSSLESS. Reads sources/ce1/reading/
 * knowledge_graph.json and gives it a content layer, in the graph's existing
 * serialization (snake_case, hasChild/supports labels):
 *   1. Each `week` (role "week") is converted IN PLACE to a content
 *      `LessonGrouping` (labels → ["LessonGrouping"]), group_name "Semaine".
 *   2. Per language-tool standard directly under a week (the six "outils de
 *      langue"), mint a content `Lesson`, RE-POINT the week→standard hasChild
 *      edge onto the Lesson, and add `Lesson --supports--> standard`.
 *   3. The standard stays on the spine with its components untouched.
 * Reads stay byte-identical: buildSlice walks week→Lesson→(supports)→standard
 * and emits the same languageToolStandards shape.
 *
 * Re-runnable: bails (no-op) if the graph already has Lesson-labelled nodes.
 * Run: node scripts/migrate-reading-graph.mjs   (add --dry to preview counts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = resolve(HERE, "..", "sources", "ce1", "reading", "knowledge_graph.json");
const DRY = process.argv.includes("--dry");

// The six language-tool strands the reading spine scopes per week — must match
// the adapter's STRAND_TYPES exactly.
const STRAND_TYPES = new Set(["Conjugaison", "Vocabulaire", "Orthographe", "Grammaire", "Écriture / Copie", "Production d'écrits"]);

function derivedId(seed) {
  const h = createHash("sha1").update(seed).digest("hex");
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const graph = JSON.parse(readFileSync(GRAPH, "utf8"));
const nodes = graph.nodes;
const rels = graph.relationships;
const byId = new Map(nodes.map((n) => [n.id, n]));

if (nodes.some((n) => (n.labels ?? []).includes("Lesson"))) {
  console.error("Refusing to run: reading graph already has Lesson-labelled nodes (already migrated?).");
  process.exit(1);
}

const roleOf = (n) => n.properties?.metadata?.role ?? null;
const isWeek = (n) => roleOf(n) === "week";
const isLangToolStandard = (n) =>
  roleOf(n) === "expectation" &&
  n.properties?.normalized_statement_type === "Standard" &&
  STRAND_TYPES.has(n.properties?.statement_type);

// 1. Convert weeks → content LessonGrouping (in place). Weeks are already
//    "Standard Grouping" nodes (title = bare-number description) — keep that so
//    the parser still reads the week number; just add the content-layer labels.
let weeksConverted = 0;
for (const n of nodes) {
  if (!isWeek(n)) continue;
  n.labels = ["LessonGrouping"];
  n.properties.normalized_type = "Lesson Grouping";
  n.properties.group_name = "Semaine";
  n.properties.group_level = n.properties?.metadata?.order ?? null;
  weeksConverted++;
}

// 2. Mint a Lesson per language-tool standard that hangs directly off a week.
//    Identify those standards via the week→standard hasChild edges.
const lessonForStd = new Map();
const newLessonNodes = [];
let repointed = 0;
for (const r of rels) {
  if (r.type !== "hasChild") continue;
  const parent = byId.get(r.start), std = byId.get(r.end);
  if (!parent || !std) continue;
  // parent was a week (now a LessonGrouping); std is a language-tool standard.
  if (!(parent.labels ?? []).includes("LessonGrouping") || !isLangToolStandard(std)) continue;
  let lid = lessonForStd.get(std.id);
  if (!lid) {
    lid = derivedId(`${std.id}:lesson`);
    lessonForStd.set(std.id, lid);
    const p = std.properties ?? {};
    newLessonNodes.push({
      id: lid,
      labels: ["Lesson"],
      properties: {
        identifier: lid,
        normalized_type: "Lesson",
        // the lesson's own title; substantive prose will live on Material nodes later.
        description: p.description ?? null,
        metadata: {},
        in_language: p.in_language ?? "fr-FR",
        academic_subject: p.academic_subject ?? "Reading",
        license: p.license ?? "https://creativecommons.org/licenses/by/4.0/",
        attribution_statement: p.attribution_statement ?? "",
        provider: p.provider ?? "Learning Commons ontology (generated)",
      },
    });
  }
  // re-point week→standard onto week→Lesson
  r.end = lid;
  if (r.properties) { r.properties.target_labels = ["Lesson"]; r.properties.target_entity = "Lesson"; }
  repointed++;
}

// 3. Add Lesson --supports--> standard (alignment / coverage).
const newSupportEdges = [];
for (const [stdId, lid] of lessonForStd) {
  const id = derivedId(`${lid}:supports:${stdId}`);
  newSupportEdges.push({
    id, type: "supports", start: lid, end: stdId,
    properties: {
      identifier: id, relationship_type: "supports",
      source_labels: ["Lesson"], source_entity: "Lesson", source_entity_key: "identifier",
      target_labels: ["StandardsFrameworkItem"], target_entity: "StandardsFrameworkItem", target_entity_key: "identifier",
      license: "https://creativecommons.org/licenses/by/4.0/",
    },
  });
}

nodes.push(...newLessonNodes);
rels.push(...newSupportEdges);

console.log(JSON.stringify({
  weeksConverted, lessonsMinted: newLessonNodes.length,
  hasChildEdgesRepointed: repointed, supportsEdgesAdded: newSupportEdges.length,
  totalNodes: nodes.length, totalRels: rels.length,
}, null, 2));

if (DRY) { console.log("(dry run — not written)"); process.exit(0); }
writeFileSync(GRAPH, JSON.stringify(graph, null, 2) + "\n");
console.log(`Wrote ${GRAPH}`);
