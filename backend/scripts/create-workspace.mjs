#!/usr/bin/env node
/*
 * Create a tenant workspace directly in the Firestore registry — the CLI twin of
 * the `create_workspace` MCP tool, for when you have Firebase creds but not MCP
 * access with a super-admin account. It performs the SAME writes the tool does
 * (see src/server/workspaces.ts::createWorkspaceOp / addMemberOp): put the
 * workspace record, optionally grant one member, and append an audit record —
 * but without going through the MCP actor/authz path (the CLI itself is the
 * trust boundary, exactly like import-kg writing straight to the KG store).
 *
 * Creating the workspace is what lets people ENTER it via set_context; it is
 * independent of importing its graph (import-kg writes the KG store separately).
 * An env-rooted super_admin can enter any workspace without a membership, so
 * --member is optional — use it to grant a specific user a role.
 *
 * Usage (after `npm run build`):
 *   node scripts/create-workspace.mjs <id> <displayName> \
 *     [--member <userId> --role curator|approver|admin [--email <e>]] \
 *     [--by <actorId>] [--dry-run]
 *
 * Env (same as the server): SERVICE_ACCOUNT_KEY_PATH (or SERVICE_ACCOUNT_KEY_JSON),
 * FIREBASE_STORAGE_BUCKET, TLM_BUCKET_PREFIX (match the runtime prefix so the
 * audit namespace lines up). --dry-run uses an in-memory store and writes nothing.
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO, "dist"))) {
  console.error("create-workspace: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { getWorkspaceStore, createMemoryWorkspaceStore } = await import(new URL("../dist/workspaces/index.js", import.meta.url));
const { getKgStore } = await import(new URL("../dist/kg-store/index.js", import.meta.url));
const { basePrefix } = await import(new URL("../dist/config.js", import.meta.url));
const { slug } = await import(new URL("../dist/utils/index.js", import.meta.url));

// ── Parse args: two positionals (<id> <displayName>) plus flags. ──────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const memberId = flag("--member");
const memberRole = flag("--role");
const memberEmail = flag("--email");
const by = flag("--by") ?? "cli:create-workspace";

// Positionals are the non-flag args, minus every flag's value.
const flagValueIdxs = new Set();
for (const name of ["--member", "--role", "--email", "--by"]) {
  const i = args.indexOf(name);
  if (i >= 0) flagValueIdxs.add(i + 1);
}
const positional = args.filter((a, i) => !a.startsWith("--") && !flagValueIdxs.has(i));

if (positional.length !== 2) {
  console.error("create-workspace: expected `<id> <displayName>` (plus optional --member/--role/--email/--by/--dry-run).");
  process.exit(1);
}
const id = slug(positional[0]);
const displayName = positional[1];

if (!id) { console.error("create-workspace: workspace id is empty after slugifying."); process.exit(1); }
if (memberId && !["curator", "approver", "admin"].includes(memberRole ?? "")) {
  console.error("create-workspace: --member requires --role curator|approver|admin.");
  process.exit(1);
}

// A CLI-operator audit actor: this bootstrap path acts as a super admin, and we
// snapshot that in the record exactly like toAuditActor would for a real actor.
const auditActor = { id: by, email: memberEmail ?? null, tokenIssuer: null, role: "super_admin", superAdmin: true, unknown: false };
const auditFor = (eventType, reason) => ({ id: randomUUID(), ts: new Date().toISOString(), actor: auditActor, namespace: basePrefix() + id, eventType, reason });

const store = dryRun ? createMemoryWorkspaceStore() : getWorkspaceStore();
console.error(`create-workspace: backend=${dryRun ? "memory" : "firestore"}, id='${id}', displayName='${displayName}'${memberId ? `, member=${memberId} (${memberRole})` : ""}`);

try {
  if (await store.getWorkspace(id)) {
    console.error(`create-workspace: workspace '${id}' already exists — leaving it as-is.`);
  } else {
    await store.putWorkspace({ id, displayName, createdBy: by, createdAt: new Date().toISOString() });
    if (!dryRun) await getKgStore().appendAudit(auditFor("workspace", `created workspace '${id}' (${displayName})`));
    console.error(`create-workspace: created workspace '${id}'.`);
  }

  if (memberId) {
    await store.putMember({ workspace: id, userId: memberId, email: memberEmail ?? undefined, role: memberRole, grantedBy: by, grantedAt: new Date().toISOString() });
    if (!dryRun) await getKgStore().appendAudit(auditFor("membership", `granted '${memberRole}' to ${memberId}${memberEmail ? ` (${memberEmail})` : ""} in '${id}'`));
    console.error(`create-workspace: granted '${memberRole}' to ${memberId} in '${id}'.`);
  }
  console.error("create-workspace: done.");
} catch (e) {
  console.error(`create-workspace: FAILED — ${(e && e.message) || e}`);
  process.exit(2);
}
