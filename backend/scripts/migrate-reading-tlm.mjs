/*
 * CE1 reading · content-layer canonicalisation + TLM document model.
 *
 * Brings reading in line with the maths phase-4 shape (see
 * docs/technical-reference/tlm-phase4-migration.md and
 * docs/design-notes/teaching-learning-materials.md). Two transforms, applied to a
 * raw Learning-Commons envelope ({ nodes, relationships }) on disk:
 *
 *   Content canonicalisation (the new bit for reading):
 *     · each session `Lesson`  → `Activity`   (its day becomes the Lesson above it)
 *     · each `Jour` day-grouping (`LessonGrouping`) → `Lesson`
 *   so the week nesting reads as the canonical LC content tree
 *   `LessonGrouping (Semaine) ─hasPart→ Lesson (day) ─hasPart→ Activity (session)`.
 *   Every edge is preserved: a session keeps its `hasEducationalAlignment` to the
 *   skill-area standard and its `usesRoutine` to its pedagogy routine — and on an
 *   `Activity` both of those are exactly the canonical edges (a routine attaches to
 *   an Activity, not a Lesson).
 *
 *   Document model (same three steps the maths migration ran):
 *     A. relabel each formatter-kind `InstructionalRoutine` → `Formatter`, and its
 *        rule-bearing `Material` children → `FormatterSpec` (content kept verbatim);
 *     B. mint one `TeachingLearningMaterial` for the Course (+ TLM ─covers→ Course),
 *        keeping the Course's current name ("Guide de l'enseignant") as the TLM name;
 *     D. re-home each formatter under that TLM (TLM ─hasPart→ Formatter) and delete
 *        the Course ─usesRoutine→ formatter edge, so NO formatter rides usesRoutine.
 *   Then rename the Course itself → "Planification": the curriculum and the
 *   deliverable are now separate nodes (Course = what to teach, TLM = what to produce).
 *
 * Order matters: the day/session sets are captured BEFORE any relabel, because a
 * relabelled day is itself a `Lesson` and must not be swept into the session pass.
 *
 * Deterministic + re-runnable: ids are derived from stable seeds, each transform is
 * guarded independently (a `Jour` grouping, a formatter routine, a Course still
 * named "Guide de l'enseignant"), and the script bails cleanly when all three are
 * already done. It never touches Firestore — the rollout is export-kg → THIS script
 * → import-kg (see docs/technical-reference/reading-tlm-migration.md).
 *
 * Usage (pure JS, no build needed):
 *   node scripts/migrate-reading-tlm.mjs --in /tmp/ce1-reading.before.json --dry
 *   node scripts/migrate-reading-tlm.mjs \
 *     --in /tmp/ce1-reading.before.json --out /tmp/ce1-reading.after.json \
 *     --namespace senegal:ce1:reading \
 *     --guide /tmp/reading-teacher-guide.assembly.md   # optional; a good default ships below
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

const inputPath = resolve(flagValue("--in", "/tmp/ce1-reading.before.json"));
const outputPath = resolve(flagValue("--out", "/tmp/ce1-reading.after.json"));
const namespaceSeed = flagValue("--namespace", "senegal:ce1:reading");
const guideFile = flagValue("--guide", null);

// The names we key transforms off. The Course is renamed FROM the first TO the
// second; the TLM keeps the original name (it IS the teacher's guide document).
const COURSE_NAME_BEFORE = "Guide de l'enseignant";
const COURSE_NAME_AFTER = "Planification";
const COURSE_NAME_AFTER_EN = "Planning";

// The document's authored "how to build me" prose. Sourced from the reading graph
// guide's "Generating documents" section; override with --guide to re-author it
// without editing this script. Kept short — the pedagogy detail lives in the
// per-session routines and the subject guide, not here.
const DEFAULT_ASSEMBLY_GUIDE = `# Guide de l'enseignant·e (CE1 lecture) — assembly guide

How to build the bilingual weekly teacher's guide (*gindeekukaayu jàngalekat bi*)
from the curriculum. The document covers the **Planification** Course; its look and
shared conventions come from this TLM's **Formatters**, and each session's phase
structure from that session's **routine**.

## What to produce, per week

Walk the week \`Semaine\` → its day \`Lesson\`s (Jour 1–5, in \`position\` order) →
each day's session \`Activity\`s (in \`position\` order). Produce **exactly** the
sessions the graph returns, in order — none added, dropped, or reordered — each with
its own language (L1 Wolof / L2 French) and duration.

For each session, \`get_standards(session)\` gives the skill-area standard it teaches
(the *osTexte*) and its components; the session's \`usesRoutine\` routine gives the
phases to follow (do not thin them out). Apply this TLM's Formatters for the page
layout, cue codes, and shared conventions.

## Faithfulness

- When a session already carries authored content (\`Material\` under it), render it
  faithfully — do not paraphrase, merge, or reorder an approved phase. When it carries
  none, compose it freely to the same grain, following its routine.
- Write native-quality Wolof (preserve every diacritic; full word forms; no French
  calque where a Wolof term exists). Titles/text stay bilingual (Wolof first, then
  French after a slash) per the session-sheet formatter's language rules.
- The guide is self-contained: reading texts (*Jukki*), illustrations, vocabulary,
  questions, exercises and expected answers all live inside it — never cite a separate
  pupil book or a page number.
- Reuse the established family cast (Mari, Badu, Omar Ndaw, Astou Diop, Póol, Rëne, the
  *maîtresse*); keep scenes anchored in everyday Senegalese life.
`;

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
const groupNameOf = (node) => node?.properties?.groupName ?? null;

const childrenVia = (parentId, edgeType) =>
  graph.relationships
    .filter((edge) => edge.type === edgeType && edge.start === parentId)
    .map((edge) => nodeById.get(edge.end))
    .filter(Boolean);

// The single containment parent of a node (reading has exactly one — its day via
// hasPart), used to tell a session Lesson apart from any stray Lesson.
function hasPartParentId(childId) {
  const edge = graph.relationships.find((e) => e.type === "hasPart" && e.end === childId);
  return edge ? edge.start : null;
}

// ── Capture the day/session sets BEFORE relabelling anything ─────────────────
// A day is a `Jour` LessonGrouping; a session is a `Lesson` whose containment
// parent is one of those days. Capturing first is what makes the two relabels
// independent AND the script re-runnable (post-migration there are no `Jour`
// groupings, so this set is empty and the relabel is skipped).
const dayGroupings = graph.nodes.filter(
  (node) => hasLabel(node, "LessonGrouping") && groupNameOf(node) === "Jour",
);
const dayGroupingIds = new Set(dayGroupings.map((node) => node.id));

const sessionLessons = graph.nodes.filter(
  (node) => hasLabel(node, "Lesson") && dayGroupingIds.has(hasPartParentId(node.id)),
);

// A Lesson NOT under a day is unexpected in reading (one-parent, day-nested). Warn
// rather than silently relabel it — the operator should look before importing.
const strayLessons = graph.nodes.filter(
  (node) => hasLabel(node, "Lesson") && !dayGroupingIds.has(hasPartParentId(node.id)),
);

// ── Relabel: session `Lesson` → `Activity` ───────────────────────────────────
// Keep every property and every edge; only the identity label changes. On an
// Activity the session's `usesRoutine` and `hasEducationalAlignment` edges are the
// canonical ones, so nothing else needs touching.
for (const session of sessionLessons) {
  session.labels = ["Activity"];
  session.properties.normalizedType = "Activity";
}

// ── Relabel: `Jour` day-grouping → `Lesson` ──────────────────────────────────
// Drop the grouping-only fields (a Lesson has no groupName / groupLevel / grouping
// statement type); keep position (the day number), description ("Jour N"), and the
// `metadata.role: "day"` note as a harmless sidecar.
for (const day of dayGroupings) {
  day.labels = ["Lesson"];
  day.properties.normalizedType = "Lesson";
  delete day.properties.groupName;
  delete day.properties.groupLevel;
  delete day.properties.normalizedStatementType;
}

// ── Document model (Steps A/B/D) — only when a formatter/Course is present ────
// A formatter today is an InstructionalRoutine tagged as such in its metadata
// sidecar (mirrors kg-recipes/catalog.ts::kindOf and migrate-tlm-documents.mjs).
function isFormatterRoutine(node) {
  if (!hasLabel(node, "InstructionalRoutine")) return false;
  const metadata = metadataOf(node);
  return metadata.catalogKind === "formatter" || metadata.role === "formatter";
}

// Strip the kind-signalling tags the LC label now carries; keep other sidecar keys
// (e.g. `summary`) verbatim, and drop an emptied metadata bag for a clean node.
function dropKindTags(node) {
  const metadata = node.properties.metadata;
  if (!metadata) return;
  delete metadata.catalogKind;
  delete metadata.role;
  if (Object.keys(metadata).length === 0) delete node.properties.metadata;
}

const formatterRoutines = graph.nodes.filter(isFormatterRoutine);
const formatterIdSet = new Set(formatterRoutines.map((node) => node.id));

// Step A — relabel formatters + their spec Materials.
let specMaterialsRelabeled = 0;
for (const formatter of formatterRoutines) {
  formatter.labels = ["Formatter"];
  dropKindTags(formatter);
  for (const spec of childrenVia(formatter.id, "hasPart").filter((child) => hasLabel(child, "Material"))) {
    spec.labels = ["FormatterSpec"];
    dropKindTags(spec);
    specMaterialsRelabeled++;
  }
}

// The Course the formatters hang off (reading has a single content Course). Its
// name — captured NOW, before the rename — becomes the TLM's name.
const course = graph.nodes.find((node) => hasLabel(node, "Course"));
const newNodes = [];
const newEdges = [];
let rehomedFormatterEdges = 0;
let usesRoutineEdgesDeleted = 0;
let tlmId = null;

if (course && formatterRoutines.length > 0) {
  const courseName = descriptionOf(course);
  const assemblyGuide = guideFile ? readFileSync(resolve(guideFile), "utf8") : DEFAULT_ASSEMBLY_GUIDE;

  // Step B — mint the TLM (+ covers → Course).
  tlmId = derivedId(`tlm:${namespaceSeed}:${course.id}`);
  newNodes.push({
    id: tlmId,
    labels: ["TeachingLearningMaterial"],
    properties: {
      description: courseName,
      metadata: { role: "teaching-learning-material", assemblyGuide },
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

  // Step D — re-home each Course ─usesRoutine→ formatter as TLM ─hasPart→ formatter,
  // and drop the old usesRoutine edge. Only formatter-targeted usesRoutine edges are
  // touched; real pedagogy routines (session ─usesRoutine→ routine) are left intact.
  const usesRoutineIdsToDelete = new Set();
  for (const edge of graph.relationships) {
    if (edge.type !== "usesRoutine" || !formatterIdSet.has(edge.end)) continue;
    const hasPartId = derivedId(`hasPart:${tlmId}->${edge.end}`);
    newEdges.push({
      id: hasPartId,
      type: "hasPart",
      start: tlmId,
      end: edge.end,
      properties: {
        identifier: hasPartId,
        relationshipType: "hasPart",
        axis: "document",
        sourceEntity: "TeachingLearningMaterial",
        targetEntity: "Formatter",
        targetLabels: ["Formatter"],
      },
    });
    usesRoutineIdsToDelete.add(edge.id);
    rehomedFormatterEdges++;
  }
  usesRoutineEdgesDeleted = usesRoutineIdsToDelete.size;
  graph.relationships = graph.relationships.filter((edge) => !usesRoutineIdsToDelete.has(edge.id));
}

// ── Rename the Course → "Planification" (only if still the pre-migration name) ─
let courseRenamed = false;
if (course && descriptionOf(course) === COURSE_NAME_BEFORE) {
  course.properties.description = COURSE_NAME_AFTER;
  course.properties.metadata = course.properties.metadata ?? {};
  course.properties.metadata.en = { ...(course.properties.metadata.en ?? {}), description: COURSE_NAME_AFTER_EN };
  courseRenamed = true;
}

// ── Guard: nothing to do ──────────────────────────────────────────────────────
if (dayGroupings.length === 0 && formatterRoutines.length === 0 && !courseRenamed) {
  console.error(
    "migrate-reading-tlm: no Jour groupings, no formatter routines, and no Course " +
      'named "Guide de l\'enseignant" — the graph is already migrated or this is the ' +
      "wrong namespace. Refusing to run.",
  );
  process.exit(1);
}

// ── Commit the additions ──────────────────────────────────────────────────────
graph.nodes.push(...newNodes);
graph.relationships.push(...newEdges);

// ── Report ────────────────────────────────────────────────────────────────────
console.log(
  JSON.stringify(
    {
      sessionsRelabeledToActivity: sessionLessons.length,
      daysRelabeledToLesson: dayGroupings.length,
      strayLessonsSkipped: strayLessons.length,
      formattersRelabeled: formatterRoutines.map((node) => descriptionOf(node)),
      specMaterialsRelabeled,
      tlmMinted: tlmId,
      formatterEdgesRehomed: rehomedFormatterEdges,
      usesRoutineEdgesDeleted,
      courseRenamed: courseRenamed ? `${COURSE_NAME_BEFORE} → ${COURSE_NAME_AFTER}` : null,
      totalNodes: graph.nodes.length,
      totalEdges: graph.relationships.length,
    },
    null,
    2,
  ),
);

if (strayLessons.length > 0) {
  console.warn(
    `\nmigrate-reading-tlm: ⚠️  ${strayLessons.length} Lesson(s) are not under a Jour ` +
      "grouping and were NOT relabelled — check them before importing.",
  );
}
if (course && formatterRoutines.length === 0) {
  console.warn(
    "\nmigrate-reading-tlm: ⚠️  a Course exists but no formatter routine was found — " +
      "no TLM was minted. If the formatters were already migrated, this is expected.",
  );
}

if (isDryRun) {
  console.log("\n(dry run — nothing written)");
  process.exit(0);
}

writeFileSync(outputPath, JSON.stringify(graph, null, 2) + "\n");
console.log(`\nWrote ${outputPath}`);
