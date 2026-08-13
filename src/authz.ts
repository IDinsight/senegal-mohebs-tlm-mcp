/*
 * Module: authz (leaf)
 *
 * Server-side authorization for graph state changes. One pure, SYNCHRONOUS
 * function called from every state-changing chokepoint (see runGraphMutation,
 * publishDraft, discardDraft in kg-store/mutations.ts + publish-flow.ts).
 *
 * Two guarantees:
 *   1. Authorization derives ONLY from the verified `Actor` (identity from the
 *      Supabase JWT; per-workspace memberships resolved once per request by the
 *      app layer and attached to the actor; super-admin from env). No tool
 *      argument, header, or client-set field influences the decision.
 *   2. Unknown / no-membership actors have no write role in a workspace; they
 *      can still read and generate — reads are ungated once you're inside a
 *      workspace (workspace ENTRY is gated at set_context; see workspaces.md).
 *
 * Roles are PER WORKSPACE (see docs/design-notes/workspaces.md). The workspace
 * is the first segment of the namespace (`<workspace>/<grade>/<subject>`), so
 * `authorize(actor, action, namespace)` derives it from the namespace and reads
 * the actor's role FOR THAT WORKSPACE. Tiers, each a superset of the last:
 *   curator     — apply / dry-run mutations, discard a draft, read a draft.
 *   approver    — + publish, read the audit trail.
 *   admin       — + manage the workspace's members.
 *   super_admin — universal across every workspace (env-rooted).
 *
 * Membership stays I/O-free HERE: the app layer does the one Firestore read and
 * hands the result on `actor.memberships`, so this function never imports the
 * store and never becomes async.
 */

import type { Actor, EffectiveRole } from "./actor.js";
import { DEFAULT_WORKSPACE, basePrefix } from "./config.js";

export type AuthAction =
  | "apply" | "discard" | "publish" | "readDraft" | "readAudit"
  | "manageMembers" | "manageWorkspace";

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: string };

// Numeric tiers so "at least approver" is a comparison, not a set membership.
const RANK: Record<EffectiveRole, number> = { curator: 1, approver: 2, admin: 3, super_admin: 4 };

// Minimum tier each action requires.
const REQUIRED: Record<AuthAction, number> = {
  apply: RANK.curator, discard: RANK.curator, readDraft: RANK.curator,
  publish: RANK.approver, readAudit: RANK.approver,
  manageMembers: RANK.admin,
  manageWorkspace: RANK.super_admin,
};

/**
 * The workspace a namespace belongs to: the first path segment after the
 * optional global bucket prefix. `senegal/ci/maths` → `senegal`. Kept in lock-
 * step with kgNamespace() (kg-store/adapter.ts), which builds the inverse.
 */
export function workspaceOf(namespace: string): string {
  const prefix = basePrefix();
  const rest = prefix && namespace.startsWith(prefix) ? namespace.slice(prefix.length) : namespace;
  return rest.split("/")[0] ?? "";
}

/**
 * The actor's effective role in a workspace, or `undefined` if none.
 *   1. super_admin (env) wins everywhere.
 *   2. an explicit membership for this workspace.
 *   3. LEGACY bridge: the global `app_role` claim grants that role, but only in
 *      DEFAULT_WORKSPACE — covers users whose Supabase role hasn't been copied
 *      into the membership registry yet. Remove once migration is complete.
 */
export function effectiveRole(actor: Actor, workspace: string): EffectiveRole | undefined {
  if (actor.unknown) return undefined;
  if (actor.superAdmin) return "super_admin";
  const membership = actor.memberships?.[workspace];
  if (membership) return membership;
  if (actor.role && workspace === DEFAULT_WORKSPACE) return actor.role;
  return undefined;
}

export function authorize(actor: Actor, action: AuthAction, namespace: string): AuthResult {
  if (actor.unknown) {
    return { ok: false, reason: "no verified identity — sign in to make changes" };
  }
  const workspace = workspaceOf(namespace);
  const role = effectiveRole(actor, workspace);
  if (!role) {
    return { ok: false, reason: `signed in as '${actor.id}' but no role is assigned in workspace '${workspace}' — ask a workspace admin to add you` };
  }
  if (RANK[role] >= REQUIRED[action]) return { ok: true };

  // Denied: role is real but too low for this action. Name the shortfall.
  switch (action) {
    case "publish":
      return { ok: false, reason: `role '${role}' cannot publish in '${workspace}' — needs 'approver' or higher` };
    case "readAudit":
      return { ok: false, reason: `role '${role}' cannot read the audit log in '${workspace}' — needs 'approver' or higher` };
    case "manageMembers":
      return { ok: false, reason: `role '${role}' cannot manage members in '${workspace}' — needs 'admin' or higher` };
    case "manageWorkspace":
      return { ok: false, reason: `role '${role}' cannot manage workspaces — only a super admin may` };
    default:
      return { ok: false, reason: `role '${role}' cannot '${action}' in '${workspace}'` };
  }
}

/**
 * Authorize a workspace-scoped admin action (create_workspace, add_member, …)
 * that has no grade/subject. Reuses the same tier logic by synthesizing the
 * namespace the workspace would key — so there is exactly ONE authorization
 * policy, not a parallel one for admin tools.
 */
export function authorizeWorkspace(actor: Actor, action: AuthAction, workspace: string): AuthResult {
  return authorize(actor, action, basePrefix() + workspace);
}

// Whether an approver may publish a draft they also authored edits in. Two
// controls compose:
//   - `TLM_ALLOW_SELF_APPROVE` env: "0" = strict separation of duties
//     (deny if any promoted apply is by the current approver); anything
//     else (default) = permissive.
//   - The publish audit record ALWAYS carries `selfAuthored: boolean` so
//     an audit review can spot self-approve even in permissive mode.
export function selfApproveAllowed(): boolean {
  return process.env.TLM_ALLOW_SELF_APPROVE !== "0";
}
