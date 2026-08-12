/*
 * Reading: nest daily sessions under Jour 1–5 LessonGroupings
 *
 * Scope B put a week's 22 sessions directly under the week LessonGrouping (day as
 * a session attribute). This inserts an explicit day layer, so containment reads
 * week → Jour(1–5) LessonGrouping → session Lesson (LC lets LessonGrouping nest
 * via hasPart). Each session already carries metadata.day, so the grouping is
 * deterministic.
 *
 * For each guide week (numeric-position week LessonGrouping):
 *   1. mint 5 day LessonGroupings (Jour 1..5; role "day", groupName "Jour",
 *      position = day number), linked week --hasPart--> day.
 *   2. re-point each week --hasPart--> session onto day --hasPart--> session,
 *      keyed by the session's metadata.day.
 * Reads stay byte-identical: buildSlice gathers sessions across the day groupings
 * and sorts by session_order.
 *
 * Deterministic + re-runnable (bails if day groupings already exist).
 * Run: node scripts/migrate-reading-day-groupings.mjs  (add --dry to preview).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = resolve(HERE, "..", "sources", "ce1", "reading", "knowledge_graph.json");
const DRY = process.argv.includes("--dry");

const derivedId = (seed) => {
  const h = createHash("sha1").update(seed).digest("hex");
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const graph = JSON.parse(readFileSync(GRAPH, "utf8"));
const nodes = graph.nodes, rels = graph.relationships;
const byId = new Map(nodes.map((n) => [n.id, n]));
const roleOf = (n) => n.properties?.metadata?.role;

if (nodes.some((n) => roleOf(n) === "day")) { console.error("Refusing to run: day groupings already exist (already migrated?)."); process.exit(1); }

// Guide weeks: week-role LessonGroupings with a numeric position (the "1 à 8"
// combined grouping has no position and holds no sessions — skip it).
const weeks = nodes.filter((n) => roleOf(n) === "week" && typeof n.properties?.position === "number");

const newDayNodes = [], newEdges = [];
let repointed = 0, daysCreated = 0;
for (const week of weeks) {
  const p = week.properties;
  // sessions currently hanging directly off the week
  const sessionEdges = rels.filter((r) => r.type === "hasPart" && r.start === week.id && (byId.get(r.end)?.labels ?? []).includes("Lesson"));
  const days = [...new Set(sessionEdges.map((e) => byId.get(e.end)?.properties?.metadata?.day).filter((d) => d != null))].sort((a, b) => a - b);

  const dayId = new Map();
  for (const day of days) {
    const id = derivedId(`${week.id}:day:${day}`);
    dayId.set(day, id);
    newDayNodes.push({
      id, labels: ["LessonGrouping"],
      properties: {
        identifier: id,
        normalizedType: "Lesson Grouping", normalizedStatementType: "Standard Grouping",
        description: `Jour ${day}`, groupName: "Jour", groupLevel: day, position: day,
        metadata: { role: "day", order: day },
        inLanguage: p.inLanguage ?? "fr", academicSubject: p.academicSubject ?? "Langue et Communication",
        license: p.license ?? "All rights reserved (source PDF)", attributionStatement: p.attributionStatement ?? "",
        author: p.author ?? null, provider: p.provider ?? "IDinsight | Learning Commons",
      },
    });
    daysCreated++;
    const hc = derivedId(`${week.id}:haspart:${id}`);
    newEdges.push({
      id: hc, type: "hasPart", start: week.id, end: id,
      properties: { identifier: hc, relationshipType: "hasPart", sourceEntity: "LessonGrouping", targetEntity: "LessonGrouping", targetLabels: ["LessonGrouping"], orderIndex: day, license: "https://creativecommons.org/licenses/by/4.0/" },
    });
  }

  // Re-point week→session onto day→session.
  for (const e of sessionEdges) {
    const day = byId.get(e.end)?.properties?.metadata?.day;
    const did = dayId.get(day);
    if (!did) continue;
    e.start = did; // reuse the edge, just move its source from the week to the day
    if (e.properties) { e.properties.sourceEntityValue = did; }
    repointed++;
  }
}

nodes.push(...newDayNodes);
rels.push(...newEdges);

console.log(JSON.stringify({
  guideWeeks: weeks.length, dayGroupingsCreated: daysCreated, sessionsRepointed: repointed,
  totalNodes: nodes.length, totalEdges: rels.length,
}, null, 2));

if (DRY) { console.log("(dry run — not written)"); process.exit(0); }
writeFileSync(GRAPH, JSON.stringify(graph, null, 2) + "\n");
console.log(`Wrote ${GRAPH}`);
