/*
 * Module: server · tool group: workspaces & membership (admin)
 *
 * The tenant-administration surface (see docs/design-notes/workspaces.md):
 *   list_workspaces   — the workspaces the caller can enter (all, if super admin).
 *   create_workspace  — super admin only.
 *   add_member        — workspace admin (their ws) or super admin (any).
 *   remove_member     — same gate; refuses removing the last admin.
 *   list_members      — same gate.
 *
 * Authorization goes through the SAME authorize() every graph tool uses (via
 * authorizeWorkspace, which has no grade/subject). Every mutation writes an
 * append-only audit record, keyed under the workspace namespace, exactly like a
 * graph mutation. Membership changes are LIVE (not drafted) — a membership is
 * not a graph node — so there is no publish step.
 */
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson } from "./shared.js";
import { currentActor } from "../actor.js";
import type { MembershipRole } from "../actor.js";
import { authorizeWorkspace, effectiveRole } from "../authz.js";
import { basePrefix } from "../config.js";
import { slug } from "../utils/index.js";
import { listAvailableContexts } from "../context/index.js";
import { getKgStore, toAuditActor } from "../kg-store/index.js";
import { getWorkspaceStore } from "../workspaces/index.js";
import { accessibleContexts } from "./context.js";

const ROLE = z.enum(["curator", "approver", "admin"]);

// Audit a membership/workspace admin action under the workspace's namespace, so
// read_audit for that workspace surfaces it alongside graph events.
async function auditAdmin(workspace: string, eventType: "membership" | "workspace", reason: string): Promise<void> {
  await getKgStore().appendAudit({
    id: randomUUID(),
    ts: new Date().toISOString(),
    actor: toAuditActor(currentActor()),
    namespace: basePrefix() + workspace,
    eventType,
    reason,
  });
}

// ── Operations (exported so tests can drive them with an injected actor +
// stores; the tool handlers below are thin asJson wrappers). Each reads the
// verified currentActor() and enforces authz — never trusting any arg for it.

export async function listWorkspacesOp(): Promise<Record<string, unknown>> {
  const actor = currentActor();
  const registry = await getWorkspaceStore().listWorkspaces().catch(() => []);
  // Ids from the registry AND installed sources (a seeded-but-unregistered
  // workspace still appears).
  const ids = new Set<string>([...registry.map((w) => w.id), ...listAvailableContexts().map((c) => c.workspace)]);
  const displayName = new Map(registry.map((w) => [w.id, w.displayName]));
  const ctxByWs = new Map<string, Array<{ grade: string; subject: string }>>();
  for (const c of accessibleContexts()) {
    (ctxByWs.get(c.workspace) ?? ctxByWs.set(c.workspace, []).get(c.workspace)!).push({ grade: c.grade, subject: c.subject });
  }
  const out = [...ids]
    .map((id) => ({ id, displayName: displayName.get(id) ?? id, role: actor.superAdmin ? "super_admin" : effectiveRole(actor, id) ?? null, contexts: ctxByWs.get(id) ?? [] }))
    .filter((w) => actor.unknown || actor.superAdmin || w.role !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { workspaces: out, superAdmin: !!actor.superAdmin };
}

export async function createWorkspaceOp(a: { id: string; displayName: string }): Promise<Record<string, unknown>> {
  const actor = currentActor();
  const id = slug(a.id);
  const authz = authorizeWorkspace(actor, "manageWorkspace", id);
  if (!authz.ok) return { ok: false, error: authz.reason };
  if (!id) return { ok: false, error: "workspace id is empty after slugifying" };
  const store = getWorkspaceStore();
  if (await store.getWorkspace(id)) return { ok: false, error: `workspace '${id}' already exists` };
  const rec = { id, displayName: a.displayName, createdBy: actor.id, createdAt: new Date().toISOString() };
  await store.putWorkspace(rec);
  await auditAdmin(id, "workspace", `created workspace '${id}' (${a.displayName})`);
  return { ok: true, workspace: rec };
}

export async function addMemberOp(a: { workspace: string; userId: string; role: MembershipRole; email?: string }): Promise<Record<string, unknown>> {
  const actor = currentActor();
  const workspace = slug(a.workspace);
  const authz = authorizeWorkspace(actor, "manageMembers", workspace);
  if (!authz.ok) return { ok: false, error: authz.reason };
  const store = getWorkspaceStore();
  if (!(await store.getWorkspace(workspace)) && !listAvailableContexts().some((c) => c.workspace === workspace)) {
    return { ok: false, error: `unknown workspace '${workspace}' — create it first` };
  }
  const rec = { workspace, userId: a.userId, email: a.email, role: a.role, grantedBy: actor.id, grantedAt: new Date().toISOString() };
  await store.putMember(rec);
  await auditAdmin(workspace, "membership", `granted '${a.role}' to ${a.userId}${a.email ? ` (${a.email})` : ""} in '${workspace}'`);
  return { ok: true, member: rec };
}

export async function removeMemberOp(a: { workspace: string; userId: string }): Promise<Record<string, unknown>> {
  const actor = currentActor();
  const workspace = slug(a.workspace);
  const authz = authorizeWorkspace(actor, "manageMembers", workspace);
  if (!authz.ok) return { ok: false, error: authz.reason };
  const store = getWorkspaceStore();
  const target = await store.getMember(workspace, a.userId);
  if (!target) return { ok: false, error: `${a.userId} is not a member of '${workspace}'` };
  if (target.role === "admin") {
    const admins = (await store.membersOf(workspace)).filter((m) => m.role === "admin");
    if (admins.length <= 1) return { ok: false, error: `cannot remove the last admin of '${workspace}' — grant another admin first` };
  }
  await store.removeMember(workspace, a.userId);
  await auditAdmin(workspace, "membership", `revoked '${target.role}' from ${a.userId} in '${workspace}'`);
  return { ok: true, removed: { workspace, userId: a.userId, role: target.role } };
}

export async function listMembersOp(a: { workspace: string }): Promise<Record<string, unknown>> {
  const actor = currentActor();
  const workspace = slug(a.workspace);
  const authz = authorizeWorkspace(actor, "manageMembers", workspace);
  if (!authz.ok) return { ok: false, error: authz.reason };
  return { workspace, members: await getWorkspaceStore().membersOf(workspace) };
}

export function registerWorkspaceTools(server: McpServer) {
  server.registerTool("list_workspaces", { title: "List workspaces", description: "List the workspaces you can enter (a super admin sees all). Each entry shows your role and its grade/subject graphs. Use this before set_context.", inputSchema: {} },
    async () => asJson(await listWorkspacesOp()));

  server.registerTool("create_workspace", { title: "Create a workspace", description: "Create a new tenant workspace (super admin only). The id becomes the top segment of every namespace it owns — use a short slug like 'kenya'. Seeding its curriculum graphs is a separate step.", inputSchema: { id: z.string(), displayName: z.string() } },
    async (a) => asJson(await createWorkspaceOp(a)));

  server.registerTool("add_member", { title: "Add / update a workspace member", description: "Grant a user a role (curator, approver, or admin) in a workspace. Requires admin in that workspace (or super admin). `userId` is the person's identity subject (Supabase JWT `sub`); `email` is an optional label. Re-granting updates the role. A workspace admin cannot grant super admin (that tier is env-configured).", inputSchema: { workspace: z.string(), userId: z.string(), role: ROLE, email: z.string().optional() } },
    async (a) => asJson(await addMemberOp(a)));

  server.registerTool("remove_member", { title: "Remove a workspace member", description: "Revoke a user's role in a workspace. Requires admin in that workspace (or super admin). Refuses to remove the workspace's last admin (so a workspace can't be orphaned).", inputSchema: { workspace: z.string(), userId: z.string() } },
    async (a) => asJson(await removeMemberOp(a)));

  server.registerTool("list_members", { title: "List workspace members", description: "List everyone with a role in a workspace. Requires admin in that workspace (or super admin).", inputSchema: { workspace: z.string() } },
    async (a) => asJson(await listMembersOp(a)));
}
