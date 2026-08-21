#!/usr/bin/env node
/*
 * Collapse ci/maths' per-lesson routine edges onto the Course.
 *
 * Every CI-maths Lesson carries its own `usesRoutine` edge to the single shared
 * "Fiche de leçon — enseignement explicite" routine — 112 identical edges pointing
 * at one routine subtree. The routine is a Course-wide default, not a per-lesson
 * choice, so this re-homes it: ONE `Course --usesRoutine--> routine` edge replaces
 * the 112 `Lesson --usesRoutine--> routine` edges. The new lesson-scoped reader
 * (walk_lesson) inherits the routine from the Course, so generation is unaffected.
 *
 * Runs through the SAME two-phase `runGraphMutation` the MCP tools use (validated +
 * audited), STAGES a draft, and does NOT publish — review with diff_draft and
 * publish with publish_draft afterwards. Idempotent + re-runnable: the Course edge
 * is only created if missing, and only lesson routine edges still present are
 * deleted, so a re-run (or a run after a partial hand-edit) is safe.
 *
 * Usage (after `npm run build`, from backend/):
 *   node scripts/migrate-maths-routine-to-course.mjs [--dry-run]
 *
 * Env (same as import-kg): SERVICE_ACCOUNT_KEY_PATH (or _JSON),
 * FIREBASE_STORAGE_BUCKET, TLM_BUCKET_PREFIX. Actor: TLM_ACTOR_EMAIL for the audit.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO, "dist"))) {
  console.error("migrate-maths-routine-to-course: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");

// This migration is hard-wired to the one namespace it describes.
const WORKSPACE = "senegal";
const GRADE = "ci";
const SUBJECT = "maths";
const ROUTINE_EDGE = "usesRoutine";

const { runGraphMutation, createFirestoreKgStore, kgNamespace, __setKgStoreForTest, deleteEdges } =
  await import(new URL("../dist/kg-store/index.js", import.meta.url));
const { createEdges } = await import(new URL("../dist/kg-recipes/index.js", import.meta.url));
const actorMod = await import(new URL("../dist/actor.js", import.meta.url));

// A named actor for the audit trail (the mutation records who edited).
if (actorMod.__setActorForTest) {
  actorMod.__setActorForTest({
    id: "migrate-routine-to-course",
    email: process.env.TLM_ACTOR_EMAIL ?? "migrate-routine-to-course@script",
    role: "curator",
    unknown: false,
  });
}

const store = createFirestoreKgStore();
if (__setKgStoreForTest) {
  __setKgStoreForTest(store);
}

const namespace = kgNamespace(WORKSPACE, GRADE, SUBJECT);

// Read the draft-else-published slot so a re-run sees edits from a prior partial run.
const pointer = await store.readPointer(namespace);
if (!pointer) {
  console.error(`migrate-routine-to-course: namespace '${namespace}' has no pointer.`);
  process.exit(1);
}
const readSlot = pointer.draftSlot ?? pointer.publishedSlot;
const nodes = await store.listNodes(namespace, readSlot);
const edges = await store.listEdges(namespace, readSlot);

const labelsOf = (node) => node.labels ?? [];

// There is exactly one content Course in ci/maths (the shared "Planification").
const courses = nodes.filter((node) => labelsOf(node).includes("Course"));
if (courses.length !== 1) {
  console.error(`migrate-routine-to-course: expected exactly one Course, found ${courses.length}. Aborting.`);
  process.exit(1);
}
const course = courses[0];

// The per-lesson routine edges to collapse: every usesRoutine edge starting at a Lesson.
const lessonIds = new Set(nodes.filter((node) => labelsOf(node).includes("Lesson")).map((node) => node.id));
const lessonRoutineEdges = edges.filter((edge) => edge.type === ROUTINE_EDGE && lessonIds.has(edge.from));

// The routine(s) those edges point at — normally the single "Fiche de leçon" entry.
const routineTargets = [...new Set(lessonRoutineEdges.map((edge) => edge.to))];

// The Course-level edges that should replace them — one per distinct routine target,
// skipping any that already exist (idempotent re-run).
const existingCourseRoutineTargets = new Set(
  edges
    .filter((edge) => edge.type === ROUTINE_EDGE && edge.from === course.id)
    .map((edge) => edge.to),
);
const courseEdgesToAdd = routineTargets
  .filter((target) => !existingCourseRoutineTargets.has(target))
  .map((target) => ({ edgeType: ROUTINE_EDGE, fromId: course.id, toId: target, properties: {} }));

console.error(`migrate-routine-to-course: namespace '${namespace}', reading slot '${readSlot}'.`);
console.error(`  Course:                 ${course.id}`);
console.error(`  routine target(s):      ${routineTargets.join(", ") || "(none)"}`);
console.error(`  Course edges to add:    ${courseEdgesToAdd.length}`);
console.error(`  lesson edges to delete: ${lessonRoutineEdges.length}`);

if (courseEdgesToAdd.length === 0 && lessonRoutineEdges.length === 0) {
  console.error("migrate-routine-to-course: nothing to do — already collapsed.");
  process.exit(0);
}

if (DRY_RUN) {
  console.error("migrate-routine-to-course: --dry-run, no draft staged.");
  process.exit(0);
}

// Two-phase apply of one GraphMutation: dry-run for the token, then confirm.
async function applyMutation(mutation, args, label) {
  const preview = await runGraphMutation({ namespace, mutation, args });
  if (preview.phase !== "preview") {
    console.error(`  ! ${label} — ${preview.phase}: ${JSON.stringify(preview.errors ?? preview.message ?? "")}`);
    process.exit(2);
  }
  const confirm = await runGraphMutation({ namespace, mutation, args, confirm: true, token: preview.confirmationToken });
  if (confirm.phase !== "apply") {
    console.error(`  ! ${label} — confirm ${confirm.phase}: ${JSON.stringify(confirm.errors ?? confirm.message ?? "")}`);
    process.exit(2);
  }
  console.error(`  ✓ ${label}`);
}

// Add the Course-level routine edge(s) FIRST, so the routine is never momentarily
// unreferenced, then drop the per-lesson edges.
if (courseEdgesToAdd.length > 0) {
  await applyMutation(createEdges, { namespace, edges: courseEdgesToAdd }, `create ${courseEdgesToAdd.length} Course routine edge(s)`);
}
if (lessonRoutineEdges.length > 0) {
  const edgeIds = lessonRoutineEdges.map((edge) => edge.id);
  await applyMutation(deleteEdges, { edgeIds }, `delete ${edgeIds.length} lesson routine edge(s)`);
}

console.error(
  `migrate-routine-to-course: done. Draft staged on '${namespace}' — review with diff_draft, publish with publish_draft.`,
);
