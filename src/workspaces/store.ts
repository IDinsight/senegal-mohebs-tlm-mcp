/*
 * Module: workspaces · store (service surface)
 *
 * Lazy singleton for the active WorkspaceStore + an in-memory implementation for
 * tests (mirrors kg-store's createMemoryKgStore / __setKgStoreForTest pattern),
 * plus resolveMemberships(): the one per-request read the app layer runs to turn
 * a user id into the `{ workspace: role }` map it hangs on the Actor.
 */
import type { MembershipRole } from "../actor.js";
import type { MembershipRecord, WorkspaceRecord, WorkspaceStore } from "./types.js";
import { createFirestoreWorkspaceStore } from "./firestore.js";

let store: WorkspaceStore | null = null;

export function getWorkspaceStore(): WorkspaceStore {
  return (store ??= createFirestoreWorkspaceStore());
}

export function __setWorkspaceStoreForTest(s: WorkspaceStore | null): void {
  store = s;
}

/**
 * The per-request membership read: collapse a user's rows into the compact
 * `{ workspace: role }` map authz reads off the Actor. One store round-trip.
 */
export async function resolveMemberships(
  userId: string,
  s: WorkspaceStore = getWorkspaceStore(),
): Promise<Record<string, MembershipRole>> {
  const rows = await s.membershipsForUser(userId);
  const out: Record<string, MembershipRole> = {};
  for (const r of rows) out[r.workspace] = r.role;
  return out;
}

// ── In-memory implementation (tests / stdio without Firestore) ────────────────
const memberKey = (workspace: string, userId: string) => `${workspace}::${userId}`;

export function createMemoryWorkspaceStore(seed?: {
  workspaces?: WorkspaceRecord[];
  members?: MembershipRecord[];
}): WorkspaceStore {
  const workspaces = new Map<string, WorkspaceRecord>();
  const members = new Map<string, MembershipRecord>();
  for (const w of seed?.workspaces ?? []) workspaces.set(w.id, w);
  for (const m of seed?.members ?? []) members.set(memberKey(m.workspace, m.userId), m);

  return {
    async listWorkspaces() {
      return [...workspaces.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    async getWorkspace(id) {
      return workspaces.get(id) ?? null;
    },
    async putWorkspace(rec) {
      workspaces.set(rec.id, rec);
    },
    async membershipsForUser(userId) {
      return [...members.values()].filter((m) => m.userId === userId);
    },
    async membersOf(workspace) {
      return [...members.values()]
        .filter((m) => m.workspace === workspace)
        .sort((a, b) => a.userId.localeCompare(b.userId));
    },
    async getMember(workspace, userId) {
      return members.get(memberKey(workspace, userId)) ?? null;
    },
    async putMember(rec) {
      members.set(memberKey(rec.workspace, rec.userId), rec);
    },
    async removeMember(workspace, userId) {
      members.delete(memberKey(workspace, userId));
    },
  };
}
