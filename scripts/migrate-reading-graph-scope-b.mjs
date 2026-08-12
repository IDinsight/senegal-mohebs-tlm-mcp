// ── Reading content-layer migration (graph-native authoring, Scope B) ─────────
// CE1 reading. Scope A gave each week a content layer of 6 language-tool Lessons
// (byte-identical reads). Scope B replaces that with the *real* teaching
// structure: the week's 22 daily sessions, which until now lived only as a
// hardcoded table in the generation prompt. This is deliberately NOT
// byte-identical — it changes reading's read projection (a per-week session list)
// and subsumes Scope A's 6 lessons (they become a subset of the 22 sessions).
//
// What it does, per guide week (the 21 numeric week groupings; 9/17/24/25 are
// integration/eval weeks and carry no sessions):
//   1. Remove Scope A's content layer entirely — every Lesson node and its
//      week→lesson `hasChild` and lesson→standard `supports` edges.
//   2. Mint 22 content `Lesson` nodes (one per session) under the week's
//      `LessonGrouping` via `hasChild`, each carrying day / order / language /
//      duration / session category as snake_case metadata (the graph's existing
//      convention).
//   3. Each session `supports` the spine standard it teaches, resolved by
//      (week, standard-type). Weeks 1–8 oral/comprehension/récitation sessions
//      align to the shared palier-1 combined standard (the "1 à 8" grouping's
//      nodes). Remédiation (CGP) teaches no standard → no `supports` (an honest,
//      first-class coverage gap).
// The spine (standards + their components) is untouched.
//
// Re-runnable: bails (no-op) if the graph already carries session Lessons.
// Run: node scripts/migrate-reading-graph-scope-b.mjs   (add --dry to preview).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = resolve(HERE, "..", "sources", "ce1", "reading", "knowledge_graph.json");
const DRY = process.argv.includes("--dry");

// ── The canonical 22-session timetable ────────────────────────────────────────
// Verbatim from the generation prompt's inventory (PROMPT_generate_lessons.md).
// `standardType` is the spine statement_type the session teaches (null =
// Remédiation, which teaches no standard). `category` is the coarse session
// family used by the read projection.
const SESSIONS = [
  { day: 1, n: 1, title: "Waxinu Lammiñ / Expression Orale",              language: "L1",              duration: "30 mn",    category: "oral",          standardType: "Expression orale" },
  { day: 1, n: 2, title: "Nàmm Déggin / Compréhension à l'Audition",      language: "L1",              duration: "30 mn",    category: "comprehension", standardType: "Lecture" },
  { day: 1, n: 3, title: "Compréhension à l'Audition",                    language: "L2",              duration: "30 mn",    category: "comprehension", standardType: "Lecture" },
  { day: 1, n: 4, title: "Baataan / Vocabulaire",                         language: "L1",              duration: "30 mn",    category: "language-tool", standardType: "Vocabulaire" },
  { day: 1, n: 5, title: "Dégginu Mbind / Compréhension Écrite",          language: "L1",              duration: "30 mn",    category: "comprehension", standardType: "Lecture" },
  { day: 2, n: 1, title: "Tari-Taalif / Poésie-Récitation",              language: "L1/L2 (parité)",  duration: "30 mn",    category: "poetry",        standardType: "Récitation" },
  { day: 2, n: 2, title: "Róofoo gi Baat / Grammaire",                    language: "L1",              duration: "30 mn",    category: "language-tool", standardType: "Grammaire" },
  { day: 2, n: 3, title: "Tëralinu Mbind / Orthographe",                  language: "L1",              duration: "30 mn",    category: "language-tool", standardType: "Orthographe" },
  { day: 2, n: 4, title: "Nasum Mbind / Production d'Écrits",             language: "L1",              duration: "30 mn",    category: "production",    standardType: "Production d'écrits" },
  { day: 2, n: 5, title: "Compréhension Écrite",                          language: "L2",              duration: "30 mn",    category: "comprehension", standardType: "Lecture" },
  { day: 2, n: 6, title: "Production d'Écrits",                           language: "L2",              duration: "30 mn",    category: "production",    standardType: "Production d'écrits" },
  { day: 2, n: 7, title: "Remédiation (CGP)",                            language: "L1/L2",           duration: "60 mn",    category: "remediation",   standardType: null },
  { day: 3, n: 1, title: "Vocabulaire",                                   language: "L2",              duration: "30 mn",    category: "language-tool", standardType: "Vocabulaire" },
  { day: 3, n: 2, title: "Identification des Mots Fréquents",             language: "L2",              duration: "30/60 mn", category: "word-id",       standardType: "Lecture" },
  { day: 3, n: 3, title: "Demalin Waxe / Conjugaison",                    language: "L1",              duration: "30 mn",    category: "language-tool", standardType: "Conjugaison" },
  { day: 3, n: 4, title: "Orthographe",                                   language: "L2",              duration: "30 mn",    category: "language-tool", standardType: "Orthographe" },
  { day: 4, n: 1, title: "Mbind / Écriture",                             language: "L1/L2 (parité)",  duration: "30 mn",    category: "writing",       standardType: "Écriture / Copie" },
  { day: 4, n: 2, title: "Grammaire",                                     language: "L2",              duration: "30 mn",    category: "language-tool", standardType: "Grammaire" },
  { day: 4, n: 3, title: "Conjugaison",                                   language: "L2",              duration: "30 mn",    category: "language-tool", standardType: "Conjugaison" },
  { day: 5, n: 1, title: "Expression Orale",                              language: "L2",              duration: "30 mn",    category: "oral",          standardType: "Expression orale" },
  { day: 5, n: 2, title: "Vocabulaire",                                   language: "L2",              duration: "30 mn",    category: "language-tool", standardType: "Vocabulaire" },
  { day: 5, n: 3, title: "Développer la Fluidité de la Lecture",          language: "L1/L2",           duration: "30 mn",    category: "fluency",       standardType: "Lecture" },
];

// "30 mn" / "30/60 mn" → an ISO-8601 duration (first value; drift is noted in the
// prompt where the curriculum diverges). Keeps the human string in metadata too.
const isoDuration = (d) => `PT${parseInt(d, 10)}M`;

function derivedId(seed) {
  const h = createHash("sha1").update(seed).digest("hex");
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const graph = JSON.parse(readFileSync(GRAPH, "utf8"));
const nodes = graph.nodes;
const rels = graph.relationships;
const byId = new Map(nodes.map((n) => [n.id, n]));

const isLesson = (n) => (n.labels ?? []).includes("Lesson");
if (nodes.some((n) => isLesson(n) && n.properties?.metadata?.session_order != null)) {
  console.error("Refusing to run: reading graph already carries session Lessons (already Scope B?).");
  process.exit(1);
}

const roleOf = (n) => n.properties?.metadata?.role ?? null;
// A node's week from its provenance topic path (role=week → its label). Numeric
// for individual weeks ("1".."23"); "1 à 8" for the palier-1 combined standards.
const weekLabelOf = (n) => {
  const parts = n.properties?.metadata?.progression_context?.topic_path_parts;
  if (Array.isArray(parts)) { const w = parts.find((p) => p.role === "week"); if (w) return String(w.label); }
  return null;
};

// ── 1. Remove Scope A's content layer (Lessons + their edges) ─────────────────
const oldLessonIds = new Set(nodes.filter(isLesson).map((n) => n.id));
const nodesAfterRemoval = nodes.filter((n) => !oldLessonIds.has(n.id));
const relsAfterRemoval = rels.filter((r) => !oldLessonIds.has(r.start) && !oldLessonIds.has(r.end));
graph.nodes = nodesAfterRemoval;
graph.relationships = relsAfterRemoval;

// ── 2. Index the spine standards by (week-label, statement_type) ──────────────
// Guide weeks resolve their own numeric standard; weeks 1–8 fall back to the
// shared "1 à 8" combined standard for the oral/reading types.
const stdIndex = new Map(); // `${weekLabel}::${statement_type}` -> standard node
for (const n of nodesAfterRemoval) {
  if (roleOf(n) !== "expectation" || n.properties?.normalized_statement_type !== "Standard") continue;
  const wk = weekLabelOf(n);
  const type = n.properties?.statement_type;
  if (!wk || !type) continue;
  stdIndex.set(`${wk}::${type}`, n);
}
const resolveStandard = (weekNum, type) =>
  stdIndex.get(`${weekNum}::${type}`) ?? stdIndex.get(`1 à 8::${type}`) ?? null;

// ── 3. Mint 22 session Lessons per guide week ─────────────────────────────────
const guideWeeks = nodesAfterRemoval
  .filter((n) => roleOf(n) === "week" && /^\d+$/.test(String(n.properties?.description ?? "")))
  .sort((a, b) => Number(a.properties.description) - Number(b.properties.description));

const newLessonNodes = [];
const newHasChildEdges = [];
const newSupportEdges = [];
let unresolved = 0;
const unresolvedSamples = [];

for (const week of guideWeeks) {
  const weekNum = Number(week.properties.description);
  const p = week.properties ?? {};
  SESSIONS.forEach((s, i) => {
    const lid = derivedId(`${week.id}:session:${s.day}.${s.n}`);
    newLessonNodes.push({
      id: lid,
      labels: ["Lesson"],
      properties: {
        identifier: lid,
        normalized_type: "Lesson",
        description: s.title, // the session title; substantive prose stays in the prompt (Scope B)
        time_required: isoDuration(s.duration),
        educational_use: "Instruction",
        metadata: {
          day: s.day,
          order_in_day: s.n,
          session_order: i + 1, // global 1..22 order within the week
          language: s.language,
          duration: s.duration,
          session_category: s.category,
        },
        in_language: p.in_language ?? "fr",
        academic_subject: p.academic_subject ?? "Langue et Communication",
        license: p.license ?? "All rights reserved (source PDF)",
        attribution_statement: p.attribution_statement ?? "",
        provider: p.provider ?? "IDinsight | Learning Commons",
      },
    });

    // week --hasChild--> session
    const hcId = derivedId(`${week.id}:haschild:${lid}`);
    newHasChildEdges.push({
      id: hcId, type: "hasChild", start: week.id, end: lid,
      properties: {
        identifier: hcId, relationship_type: "hasChild",
        description: "A hasChild relationship links a parent grouping to a child lesson.",
        source_entity: "LessonGrouping", source_entity_key: "identifier", source_entity_value: week.id,
        target_entity: "Lesson", target_entity_key: "identifier", target_entity_value: lid,
        target_labels: ["Lesson"], order_index: i + 1,
        license: "https://creativecommons.org/licenses/by/4.0/",
        metadata: { source_kg: "graph_native_authoring", export_order_index: i + 1 },
      },
    });

    // session --supports--> standard (alignment / coverage), where one exists
    if (s.standardType) {
      const std = resolveStandard(weekNum, s.standardType);
      if (std) {
        const supId = derivedId(`${lid}:supports:${std.id}`);
        newSupportEdges.push({
          id: supId, type: "supports", start: lid, end: std.id,
          properties: {
            identifier: supId, relationship_type: "supports",
            source_labels: ["Lesson"], source_entity: "Lesson", source_entity_key: "identifier",
            target_labels: ["StandardsFrameworkItem"], target_entity: "StandardsFrameworkItem", target_entity_key: "identifier",
            license: "https://creativecommons.org/licenses/by/4.0/",
          },
        });
      } else {
        unresolved++;
        if (unresolvedSamples.length < 10) unresolvedSamples.push(`week ${weekNum} / ${s.title} → ${s.standardType}`);
      }
    }
  });
}

graph.nodes.push(...newLessonNodes);
graph.relationships.push(...newHasChildEdges, ...newSupportEdges);

console.log(JSON.stringify({
  scopeALessonsRemoved: oldLessonIds.size,
  guideWeeks: guideWeeks.length,
  sessionsMinted: newLessonNodes.length,
  hasChildEdgesAdded: newHasChildEdges.length,
  supportsEdgesAdded: newSupportEdges.length,
  unresolvedAlignments: unresolved,
  totalNodes: graph.nodes.length,
  totalRels: graph.relationships.length,
}, null, 2));
if (unresolved) console.warn("UNRESOLVED (no standard found):\n  " + unresolvedSamples.join("\n  "));

if (DRY) { console.log("(dry run — not written)"); process.exit(0); }
writeFileSync(GRAPH, JSON.stringify(graph, null, 2) + "\n");
console.log(`Wrote ${GRAPH}`);
