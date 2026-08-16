#!/usr/bin/env node
/*
 * Apply a batch of node field-edits from a JSON file to a namespace's DRAFT, via
 * the same two-phase `editNode` mutation the edit_node tool uses (so every edit is
 * validated + audited through runGraphMutation). A bulk, reviewable alternative to
 * dozens of edit_node MCP calls — the edits live in a data file, not in tool calls.
 *
 * It STAGES a draft (lazily created) and does NOT publish — review with diff_draft
 * and publish with publish_draft afterwards. Idempotent: an edit whose target value
 * already matches (in the draft-else-published slot) is skipped, so a re-run — or a
 * run after some edits were already applied by hand — is safe.
 *
 * Usage (after `npm run build`):
 *   node scripts/apply-edits.mjs <workspace> <grade> <subject> <edits.json>
 *
 * edits.json: [{ "id": "<nodeId>", "field": "content"|"summary"|"title"|"title_en", "value": "<text>" }, …]
 *
 * Env (same as import-kg): SERVICE_ACCOUNT_KEY_PATH (or _JSON), FIREBASE_STORAGE_BUCKET,
 * TLM_BUCKET_PREFIX. Actor: set TLM_ACTOR_EMAIL for the audit trail (else a script actor).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO, "dist"))) {
  console.error("apply-edits: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { runGraphMutation, createFirestoreKgStore, kgNamespace, __setKgStoreForTest } =
  await import(new URL("../dist/kg-store/index.js", import.meta.url));
const { editNode } = await import(new URL("../dist/kg-recipes/index.js", import.meta.url));
const actorMod = await import(new URL("../dist/actor.js", import.meta.url));

const args = process.argv.slice(2);
if (args.length !== 4) {
  console.error("apply-edits: expected `<workspace> <grade> <subject> <edits.json>`.");
  process.exit(1);
}
const [workspace, grade, subject, editsPath] = args;
const edits = JSON.parse(readFileSync(resolve(editsPath), "utf8"));
const namespace = kgNamespace(workspace, grade, subject);

// A named actor for the audit trail (the mutation records who edited).
if (actorMod.__setActorForTest) {
  actorMod.__setActorForTest({ id: "apply-edits-script", email: process.env.TLM_ACTOR_EMAIL ?? "apply-edits@script", role: "curator", unknown: false });
}

const store = createFirestoreKgStore();
if (__setKgStoreForTest) __setKgStoreForTest(store);

// Read the current value of a field on a node in the draft-else-published slot, to
// skip edits already applied. content → raw.content; summary → raw.metadata.summary;
// title → raw.description; title_en → raw.metadata.en.description.
function currentValue(node, field) {
  const raw = node?.properties?.raw ?? {};
  if (field === "content") return raw.content;
  if (field === "summary") return (raw.metadata ?? {}).summary;
  if (field === "title") return raw.description;
  if (field === "title_en") return ((raw.metadata ?? {}).en ?? {}).description;
  return undefined;
}

const pointer = await store.readPointer(namespace);
if (!pointer) { console.error(`apply-edits: namespace '${namespace}' has no pointer.`); process.exit(1); }
const readSlot = pointer.draftSlot ?? pointer.publishedSlot;
const nodes = await store.listNodes(namespace, readSlot);
const byId = new Map(nodes.map((n) => [n.id, n]));

let applied = 0, skipped = 0, failed = 0;
for (const e of edits) {
  const id = e.id ?? e.nodeId;
  const node = byId.get(id);
  if (!node) { console.error(`  ! ${id} [${e.field}] — node not found in ${readSlot}`); failed++; continue; }
  if (currentValue(node, e.field) === e.value) { console.error(`  = ${id} [${e.field}] — already up to date, skipped`); skipped++; continue; }

  const mutArgs = { namespace, nodeId: id, [e.field]: e.value };
  const preview = await runGraphMutation({ namespace, mutation: editNode, args: mutArgs });
  if (preview.phase !== "preview") { console.error(`  ! ${id} [${e.field}] — ${preview.phase}: ${JSON.stringify(preview.errors ?? preview.message ?? "")}`); failed++; continue; }
  const confirm = await runGraphMutation({ namespace, mutation: editNode, args: mutArgs, confirm: true, token: preview.confirmationToken });
  if (confirm.phase !== "apply") { console.error(`  ! ${id} [${e.field}] — confirm ${confirm.phase}`); failed++; continue; }
  console.error(`  ✓ ${id} [${e.field}]`);
  applied++;
}

console.error(`apply-edits: done — ${applied} applied, ${skipped} skipped, ${failed} failed. Draft on '${namespace}'; review with diff_draft, publish with publish_draft.`);
if (failed) process.exit(2);
