#!/usr/bin/env node
/*
 * Write a subject-profile config cell ({ core, guide }) directly into a store
 * slot — the REPAIR path for a config cell that is too invalid to activate.
 *
 * Why this exists: when the published config cell is malformed for the running
 * code (e.g. it still carries a key the current schema retired), the server
 * refuses to activate that namespace. That blocks `edit_profile` (which needs an
 * activated context), and `import-kg` can't help either — it only writes slot
 * "a" and never repoints, so it can't fix a bad cell living in the *published*
 * slot. This script closes that gap. See the rollout skill's "Recovery"
 * section and docs/technical-reference/store.md.
 *
 * By default it targets the namespace's CURRENTLY PUBLISHED slot, so the fix is
 * live immediately with no pointer flip. The config is validated with the SAME
 * check the server runs on activation (buildAdapterFromStoredProfile), so it
 * refuses to write a cell that would not activate.
 *
 * This writes the cell directly — no draft, no audit record — deliberately
 * outside the two-phase curator loop that the broken cell blocks. Use it only to
 * repair; ordinary profile/guide edits go through edit_profile.
 *
 * Usage (after `npm run build`):
 *   node scripts/write-profile.mjs <workspace> <grade> <subject> [--profile p.json] [--slot a|b|published] [--dry-run]
 *
 * Config source: --profile <path> ({ core, guide } JSON) wins; otherwise the
 * in-repo { core, guide } literal for that grade/subject.
 *
 * Env (same as import-kg): SERVICE_ACCOUNT_KEY_PATH (or SERVICE_ACCOUNT_KEY_JSON),
 * FIREBASE_STORAGE_BUCKET, TLM_BUCKET_PREFIX (match the runtime prefix so the
 * namespace lines up). --dry-run reads the real store but writes nothing.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO, "dist"))) {
  console.error("write-profile: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { getRegisteredProfile, getRegisteredGuide, buildAdapterFromStoredProfile } =
  await import(new URL("../dist/adapters/index.js", import.meta.url));
const { kgNamespace, createFirestoreKgStore } =
  await import(new URL("../dist/kg-store/index.js", import.meta.url));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const profileIdx = args.indexOf("--profile");
const profilePath = profileIdx >= 0 ? args[profileIdx + 1] : null;
const slotIdx = args.indexOf("--slot");
const slotArg = slotIdx >= 0 ? args[slotIdx + 1] : "published";
// Drop the value that follows a flag — but only when the flag is actually
// present (indexOf returns -1 when absent, and -1 + 1 = 0 would wrongly drop the
// first positional).
const flagValueIdx = new Set();
if (profileIdx >= 0) flagValueIdx.add(profileIdx + 1);
if (slotIdx >= 0) flagValueIdx.add(slotIdx + 1);
const positional = args.filter((a, i) => !a.startsWith("--") && !flagValueIdx.has(i));

if (positional.length !== 3) {
  console.error("write-profile: expected `<workspace> <grade> <subject>` (plus optional --profile <path> / --slot a|b|published / --dry-run).");
  process.exit(1);
}
const [workspace, grade, subject] = positional;

// Config source: an explicit --profile file wins; otherwise the in-repo literal.
let config;
if (profilePath) {
  config = JSON.parse(readFileSync(resolve(profilePath), "utf8"));
} else {
  const core = getRegisteredProfile(workspace, grade, subject);
  if (!core) {
    console.error(`write-profile: no in-repo profile for '${workspace}/${grade}/${subject}'. Pass --profile <path>.`);
    process.exit(1);
  }
  const guide = getRegisteredGuide(workspace, grade, subject);
  config = guide !== undefined ? { core, guide } : { core };
}

// Validate exactly as the server does on activation, so we never write a cell
// that would refuse to activate.
try {
  buildAdapterFromStoredProfile(workspace, grade, subject, config);
} catch (e) {
  console.error(`write-profile: REFUSED — config would not activate: ${(e && e.message) || e}`);
  process.exit(2);
}

const namespace = kgNamespace(workspace, grade, subject);
const store = createFirestoreKgStore();

try {
  const pointer = await store.readPointer(namespace);
  if (!pointer) {
    console.error(`write-profile: namespace '${namespace}' has no pointer — nothing to repair. Use import-kg to create it.`);
    process.exit(1);
  }
  const slot = slotArg === "published" ? pointer.publishedSlot : slotArg;
  if (slot !== "a" && slot !== "b") {
    console.error(`write-profile: bad --slot '${slotArg}' (expected a | b | published).`);
    process.exit(1);
  }
  const guideLen = config.guide ? config.guide.length : 0;
  console.error(`write-profile: ns='${namespace}', publishedSlot='${pointer.publishedSlot}', target slot='${slot}', guide=${guideLen} chars${dryRun ? " (dry-run — no write)" : ""}.`);
  if (!dryRun) {
    await store.writeConfig(namespace, slot, config);
    console.error("write-profile: done — config cell written.");
  }
} catch (e) {
  console.error(`write-profile: FAILED — ${(e && e.message) || e}`);
  process.exit(2);
}
