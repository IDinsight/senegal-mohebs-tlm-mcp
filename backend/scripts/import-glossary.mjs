#!/usr/bin/env node
/*
 * Import an on-disk terminology.json into a workspace's bilingual lexicon
 * (`<workspace>/_glossary/terms`) as LexiconEntry nodes — the data half of the
 * glossary-store rollout (step 2). The on-disk file stays as the fallback the
 * server reads until a workspace has a glossary; this script populates that
 * glossary so reads switch to the store.
 *
 * MERGE, not clobber: it reads the currently-published glossary, keeps every
 * existing entry, and appends only source terms not already present (deduped by
 * normalized fr|wo), so a re-run is idempotent and never drops terms added via
 * add_terms. It writes the currently-published slot in place (or seeds a fresh
 * namespace), so the import is live with no pointer flip — like write-profile,
 * this is a direct operator write, outside the two-phase curator loop.
 *
 * Usage (after `npm run build`):
 *   node scripts/import-glossary.mjs <workspace> <grade> <subject> [--narrow-subject] [--dry-run]
 *
 * <workspace> <grade> <subject> locate the SOURCE terminology.json under the
 * assets dir; the TARGET is always the workspace glossary namespace. By default
 * imported terms are workspace-wide; --narrow-subject tags each with the source
 * subject so it applies only in that subject's context.
 *
 * Env (same as import-kg): SERVICE_ACCOUNT_KEY_PATH (or SERVICE_ACCOUNT_KEY_JSON),
 * FIREBASE_STORAGE_BUCKET, TLM_BUCKET_PREFIX (match the runtime prefix so the
 * namespace lines up). --dry-run reads the real store but writes nothing.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO, "dist"))) {
  console.error("import-glossary: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { CONFIG } = await import(new URL("../dist/config.js", import.meta.url));
const { createFirestoreKgStore } = await import(new URL("../dist/kg-store/index.js", import.meta.url));
const { glossaryNamespace, buildLexiconNode, normalizeRenderings, isLexiconNode, parseEntry } =
  await import(new URL("../dist/glossary/index.js", import.meta.url));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const narrowSubject = args.includes("--narrow-subject");
const positional = args.filter((a) => !a.startsWith("--"));
if (positional.length !== 3) {
  console.error("import-glossary: expected `<workspace> <grade> <subject>` (plus optional --narrow-subject / --dry-run).");
  process.exit(1);
}
const [workspace, grade, subject] = positional;

// ── Read the source terminology.json ─────────────────────────────────────────
const sourcePath = resolve(CONFIG.assetsDir, workspace, grade, subject, CONFIG.terminologyFile);
if (!existsSync(sourcePath)) {
  console.error(`import-glossary: no terminology file at ${sourcePath}.`);
  process.exit(1);
}
const rawFile = JSON.parse(readFileSync(sourcePath, "utf8"));

// Flatten sections → entries into LexiconEntry inputs. francais→fr, wolof→wo,
// exemple→example, the section title→a tag. Entries with no wording are skipped.
const sourceEntries = [];
for (const section of rawFile.sections ?? []) {
  for (const e of section.entrees ?? []) {
    const renderings = normalizeRenderings({ fr: e.francais ?? "", wo: e.wolof ?? "" });
    if (Object.keys(renderings).length === 0) continue;
    sourceEntries.push({
      renderings,
      ...(narrowSubject ? { subject } : {}),
      ...(e.exemple ? { example: e.exemple } : {}),
      ...(section.titre ? { tags: [section.titre] } : {}),
    });
  }
}

// Dedup key: the normalized fr|wo pair, so re-imports and cross-source overlaps
// don't duplicate a term.
const keyOf = (renderings) => `${renderings.fr ?? ""}||${renderings.wo ?? ""}`;

// ── Merge into the published glossary slot ───────────────────────────────────
const namespace = glossaryNamespace(workspace);
const store = createFirestoreKgStore();

const strip = (node) => { const { slot, ...rest } = node; return rest; };

try {
  const pointer = await store.readPointer(namespace);
  const targetSlot = pointer ? pointer.publishedSlot : "a";

  const existingNodes = pointer ? (await store.listNodes(namespace, targetSlot)).filter(isLexiconNode).map(strip) : [];
  const existingKeys = new Set(existingNodes.map((n) => keyOf(parseEntry(n).renderings)));

  const toAdd = sourceEntries.filter((entry) => !existingKeys.has(keyOf(entry.renderings)));
  const newNodes = toAdd.map((entry) => buildLexiconNode(entry, randomUUID(), namespace));
  const nodes = [...existingNodes, ...newNodes];

  console.error(
    `import-glossary: source=${sourcePath}\n` +
    `  ns='${namespace}', slot='${targetSlot}'${pointer ? "" : " (new namespace)"}, mode=${narrowSubject ? `narrowed to subject '${subject}'` : "workspace-wide"}\n` +
    `  source entries=${sourceEntries.length}, already present=${sourceEntries.length - toAdd.length}, to add=${toAdd.length}, total after=${nodes.length}` +
    (dryRun ? "\n  (dry-run — no write)" : ""),
  );
  if (dryRun) process.exit(0);

  const meta = {
    contentHash: "",
    seededAt: new Date().toISOString(),
    adapterId: "glossary/lexicon-v1",
    nodeCount: nodes.length,
    edgeCount: 0,
  };
  await store.writeSlot(namespace, targetSlot, { nodes, edges: [], meta });
  if (!pointer) await store.ensurePointer(namespace, targetSlot);
  console.error("import-glossary: done — glossary written.");
} catch (e) {
  console.error(`import-glossary: FAILED — ${(e && e.message) || e}`);
  process.exit(2);
}
