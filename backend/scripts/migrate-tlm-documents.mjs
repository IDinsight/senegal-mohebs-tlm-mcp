/*
 * Phase 4 · TLM document-model migration (Steps A, B, D of the runbook).
 *
 * Turns the stopgap "a document IS a Course, its formatting is a usesRoutine
 * routine" shape into the first-class document model: each Course gets its own
 * TeachingLearningMaterial (TLM) node that `covers` it, and the doc-wide
 * formatters move off the Course's `usesRoutine` edge onto the TLM via `hasPart`.
 * See docs/technical-reference/tlm-phase4-migration.md and
 * docs/design-notes/teaching-learning-materials.md.
 *
 *   A. relabel each formatter-kind InstructionalRoutine → Formatter, and its
 *      rule-bearing Material children → FormatterSpec (content kept verbatim);
 *   B. mint one TeachingLearningMaterial per Course (+ TLM ─covers→ Course);
 *   D. re-home each formatter under the TLM of the Course that used it
 *      (TLM ─hasPart→ Formatter) and delete the old `usesRoutine` edge.
 *
 * Step C (the optional DocumentSection spine) is deliberately NOT built here —
 * it encodes authored per-chapter layout decisions; the coarse `covers` fallback
 * is what walk_document reads until sections are authored.
 *
 * Deterministic + re-runnable: ids are derived from stable seeds, and the script
 * bails cleanly when the graph carries no formatter-kind routine (already
 * migrated / wrong namespace), matching scripts/migrate-rece-derived-components.mjs.
 *
 * This operates on a raw Learning-Commons envelope ({ nodes, relationships }) on
 * disk — the firestore-only rollout is: export-kg → THIS script → import-kg (see
 * the runbook). It never touches Firestore itself.
 *
 * Usage (after `npm run build` is not required — this script is pure JS):
 *   node scripts/migrate-tlm-documents.mjs --dry           # prints the delta, writes nothing
 *   node scripts/migrate-tlm-documents.mjs                 # writes --out
 *   node scripts/migrate-tlm-documents.mjs \
 *     --in /tmp/ci-maths.before.json --out /tmp/ci-maths.after.json \
 *     --namespace senegal:ci:maths \
 *     --guide "Guide de l'enseignant=/tmp/teacher-guide.md" \
 *     --guide "Outil de l'élève=/tmp/student-guide.md"
 *
 * `--namespace` seeds the TLM ids (tlm:<namespace>:<courseId>) so they are stable
 * across environments. `--guide "<course description>=<file>"` (repeatable) pastes
 * that document's authored `metadata.assemblyGuide`; a Course with no --guide gets
 * a TLM with no assemblyGuide and a printed reminder to add one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// ── CLI args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const isDryRun = argv.includes("--dry");

function flagValue(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

const inputPath = resolve(flagValue("--in", "/tmp/ci-maths.before.json"));
const outputPath = resolve(flagValue("--out", "/tmp/ci-maths.after.json"));
const namespaceSeed = flagValue("--namespace", "senegal:ci:maths");

// Every --guide "<course description>=<file>" pair → the assembly guide for that
// document. Keyed by the Course's `description` (its human name), since that is
// what an operator can see and match to a runbook document.
const assemblyGuideByCourseName = new Map();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--guide") continue;
  const pair = argv[i + 1] ?? "";
  const splitAt = pair.indexOf("=");
  if (splitAt < 0) {
    console.error(`migrate-tlm: --guide expects "<course description>=<file>", got "${pair}".`);
    process.exit(1);
  }
  const courseName = pair.slice(0, splitAt);
  const guideFile = pair.slice(splitAt + 1);
  assemblyGuideByCourseName.set(courseName, readFileSync(resolve(guideFile), "utf8"));
}

// ── Stable-id helper (UUIDv5-style, matches the other migration scripts) ─────
function derivedId(seed) {
  const hash = createHash("sha1").update(seed).digest("hex");
  const variant = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// ── Load the graph ──────────────────────────────────────────────────────────
const graph = JSON.parse(readFileSync(inputPath, "utf8"));
const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

const labelsOf = (node) => node?.labels ?? [];
const hasLabel = (node, label) => labelsOf(node).includes(label);
const descriptionOf = (node) => node?.properties?.description ?? "";
const metadataOf = (node) => node?.properties?.metadata ?? {};

// A formatter today is an InstructionalRoutine tagged as a formatter in its
// metadata sidecar — either catalogKind or role (mirrors kg-recipes/catalog.ts::kindOf).
function isFormatterRoutine(node) {
  if (!hasLabel(node, "InstructionalRoutine")) return false;
  const metadata = metadataOf(node);
  return metadata.catalogKind === "formatter" || metadata.role === "formatter";
}

const childrenVia = (parentId, edgeType) =>
  graph.relationships
    .filter((edge) => edge.type === edgeType && edge.start === parentId)
    .map((edge) => nodeById.get(edge.end))
    .filter(Boolean);

// ── Guard: nothing to do ─────────────────────────────────────────────────────
const formatterRoutines = graph.nodes.filter(isFormatterRoutine);
if (formatterRoutines.length === 0) {
  console.error(
    "migrate-tlm: found 0 formatter-kind routines — the graph is already migrated " +
      "or this is the wrong namespace. Refusing to run.",
  );
  process.exit(1);
}

// Strip the kind-signaling metadata tags that the LC label now carries, leaving
// any other sidecar keys (e.g. `summary`) verbatim. Deletes an emptied metadata
// bag so the migrated node is canonical-clean.
function dropKindTags(node) {
  const metadata = node.properties.metadata;
  if (!metadata) return;
  delete metadata.catalogKind;
  // `role` here says "instructional-routine[-material]" — now false on a
  // Formatter/FormatterSpec, so it goes too.
  delete metadata.role;
  if (Object.keys(metadata).length === 0) {
    delete node.properties.metadata;
  }
}

// ── Step A — relabel formatters + their spec Materials ───────────────────────
const relabeledSpecs = [];
for (const formatter of formatterRoutines) {
  formatter.labels = ["Formatter"];
  dropKindTags(formatter);

  // The formatter's rule-bearing Material children become FormatterSpec nodes,
  // content untouched, still hung off the formatter by the same hasPart edge.
  const specMaterials = childrenVia(formatter.id, "hasPart").filter((child) => hasLabel(child, "Material"));
  for (const spec of specMaterials) {
    spec.labels = ["FormatterSpec"];
    dropKindTags(spec);
    relabeledSpecs.push(spec);
  }
}

// ── Resolve, for each Course, the formatters that were used on it ────────────
// A doc-wide formatter is attached to a Course by `usesRoutine`. (In the live
// ci/maths graph every formatter hangs off the Student's Book Course this way.)
// A formatter attached to a Lesson instead is re-homed under that Lesson's owning
// Course — resolved by walking containment parents up to the nearest Course.
const formatterIdSet = new Set(formatterRoutines.map((formatter) => formatter.id));

function owningCourseId(startNodeId) {
  const startNode = nodeById.get(startNodeId);
  if (!startNode) return null;
  if (hasLabel(startNode, "Course")) return startNodeId;

  // Walk up containment (hasPart/hasChild parents) to the first Course ancestor.
  const containmentEdges = new Set(["hasPart", "hasChild"]);
  const visited = new Set([startNodeId]);
  let frontier = [startNodeId];
  while (frontier.length > 0) {
    const nextFrontier = [];
    for (const childId of frontier) {
      const parentEdges = graph.relationships.filter(
        (edge) => containmentEdges.has(edge.type) && edge.end === childId,
      );
      for (const edge of parentEdges) {
        if (visited.has(edge.start)) continue;
        visited.add(edge.start);
        if (hasLabel(nodeById.get(edge.start), "Course")) return edge.start;
        nextFrontier.push(edge.start);
      }
    }
    frontier = nextFrontier;
  }
  return null;
}

// courseId → Set(formatterId) it uses via usesRoutine.
const formattersByCourseId = new Map();
const usesRoutineEdgesToDelete = [];
for (const edge of graph.relationships) {
  if (edge.type !== "usesRoutine" || !formatterIdSet.has(edge.end)) continue;

  const courseId = owningCourseId(edge.start);
  if (!courseId) {
    console.error(
      `migrate-tlm: formatter '${edge.end}' is used by '${edge.start}', which has no ` +
        "Course ancestor — cannot decide which TLM should own it. Aborting.",
    );
    process.exit(1);
  }
  if (!formattersByCourseId.has(courseId)) {
    formattersByCourseId.set(courseId, new Set());
  }
  formattersByCourseId.get(courseId).add(edge.end);
  usesRoutineEdgesToDelete.push(edge);
}

// ── Step B — mint one TLM per Course (+ covers) ──────────────────────────────
const courses = graph.nodes.filter((node) => hasLabel(node, "Course"));
const newNodes = [];
const newEdges = [];
const tlmIdByCourseId = new Map();
const coursesMissingGuide = [];

for (const course of courses) {
  const tlmId = derivedId(`tlm:${namespaceSeed}:${course.id}`);
  tlmIdByCourseId.set(course.id, tlmId);

  const courseName = descriptionOf(course);
  const assemblyGuide = assemblyGuideByCourseName.get(courseName);
  if (assemblyGuide === undefined) {
    coursesMissingGuide.push(courseName || course.id);
  }

  const tlmMetadata = { role: "teaching-learning-material" };
  if (assemblyGuide !== undefined) {
    tlmMetadata.assemblyGuide = assemblyGuide;
  }

  newNodes.push({
    id: tlmId,
    labels: ["TeachingLearningMaterial"],
    properties: {
      description: courseName,
      metadata: tlmMetadata,
    },
  });

  const coversId = derivedId(`covers:${tlmId}->${course.id}`);
  newEdges.push({
    id: coversId,
    type: "covers",
    start: tlmId,
    end: course.id,
    properties: {
      identifier: coversId,
      relationshipType: "covers",
      sourceEntity: "TeachingLearningMaterial",
      targetEntity: "Course",
      targetLabels: ["Course"],
    },
  });
}

// ── Step D — re-home formatters under their Course's TLM (hasPart) ───────────
let rehomedFormatterEdges = 0;
for (const [courseId, formatterIds] of formattersByCourseId) {
  const tlmId = tlmIdByCourseId.get(courseId);
  for (const formatterId of formatterIds) {
    const hasPartId = derivedId(`hasPart:${tlmId}->${formatterId}`);
    newEdges.push({
      id: hasPartId,
      type: "hasPart",
      start: tlmId,
      end: formatterId,
      properties: {
        identifier: hasPartId,
        relationshipType: "hasPart",
        axis: "document",
        sourceEntity: "TeachingLearningMaterial",
        targetEntity: "Formatter",
        targetLabels: ["Formatter"],
      },
    });
    rehomedFormatterEdges++;
  }
}

// Drop the old Course/Lesson ─usesRoutine→ formatter edges (Step D). Non-formatter
// usesRoutine edges — real InstructionalRoutine pedagogy — are left untouched.
const usesRoutineIdsToDelete = new Set(usesRoutineEdgesToDelete.map((edge) => edge.id));
graph.relationships = graph.relationships.filter((edge) => !usesRoutineIdsToDelete.has(edge.id));

// ── Commit the additions ──────────────────────────────────────────────────────
graph.nodes.push(...newNodes);
graph.relationships.push(...newEdges);

// ── Report ────────────────────────────────────────────────────────────────────
console.log(
  JSON.stringify(
    {
      formattersRelabeled: formatterRoutines.map((formatter) => descriptionOf(formatter)),
      specMaterialsRelabeled: relabeledSpecs.length,
      tlmsMinted: courses.map((course) => ({
        course: descriptionOf(course) || course.id,
        tlm: tlmIdByCourseId.get(course.id),
        hasAssemblyGuide: assemblyGuideByCourseName.has(descriptionOf(course)),
      })),
      formatterEdgesRehomed: rehomedFormatterEdges,
      usesRoutineEdgesDeleted: usesRoutineEdgesToDelete.length,
      totalNodes: graph.nodes.length,
      totalEdges: graph.relationships.length,
    },
    null,
    2,
  ),
);

if (coursesMissingGuide.length > 0) {
  console.warn(
    `\nmigrate-tlm: ⚠️  no --guide given for: ${coursesMissingGuide.join(", ")}. ` +
      "Their TLMs have NO assemblyGuide — paste the authored 'how to build me' prose " +
      "(from the retired chapter prompt / the subject guide) before or after import.",
  );
}

if (isDryRun) {
  console.log("\n(dry run — nothing written)");
  process.exit(0);
}

writeFileSync(outputPath, JSON.stringify(graph, null, 2) + "\n");
console.log(`\nWrote ${outputPath}`);
