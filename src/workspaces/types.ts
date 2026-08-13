/*
 * Module: workspaces · types (service surface)
 *
 * The tenant registry: which workspaces exist and who holds what role in each.
 * This is authorization DATA (distinct from Supabase identity) — see
 * docs/design-notes/workspaces.md. Subject-agnostic: it knows workspaces and
 * memberships, never grade/subject/chapter.
 */
import type { MembershipRole } from "../actor.js";

/** A tenant. Its id is the top segment of every namespace it owns. */
export type WorkspaceRecord = {
  id: string;                 // slug, e.g. "senegal" — matches the namespace segment
  displayName: string;
  createdBy: string;          // actor id of the super admin who created it
  createdAt: string;          // ISO-8601 UTC
  archived?: boolean;
};

/** One user's role in one workspace. Doc id = `${workspace}::${userId}`. */
export type MembershipRecord = {
  workspace: string;
  userId: string;             // JWT sub
  email?: string;             // convenience label; never used for auth
  role: MembershipRole;
  grantedBy: string;          // actor id who granted it
  grantedAt: string;          // ISO-8601 UTC
};

export interface WorkspaceStore {
  listWorkspaces(): Promise<WorkspaceRecord[]>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  putWorkspace(rec: WorkspaceRecord): Promise<void>;

  /** All memberships for one user, across every workspace (the per-request read). */
  membershipsForUser(userId: string): Promise<MembershipRecord[]>;
  /** All members of one workspace (for list_members / last-admin checks). */
  membersOf(workspace: string): Promise<MembershipRecord[]>;
  getMember(workspace: string, userId: string): Promise<MembershipRecord | null>;
  putMember(rec: MembershipRecord): Promise<void>;
  removeMember(workspace: string, userId: string): Promise<void>;
}
