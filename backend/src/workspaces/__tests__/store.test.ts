/*
 * Unit tests for the in-memory WorkspaceStore + resolveMemberships().
 * The Firestore impl is exercised only in deployment (no emulator here); the
 * memory store is the behavioral contract every caller relies on.
 */
import { describe, it, expect } from "vitest";
import { createMemoryWorkspaceStore, resolveMemberships } from "../index.js";
import type { MembershipRecord } from "../index.js";

const member = (workspace: string, userId: string, role: MembershipRecord["role"]): MembershipRecord =>
  ({ workspace, userId, role, grantedBy: "seed", grantedAt: "1970-01-01T00:00:00Z" });

describe("memory WorkspaceStore", () => {
  it("round-trips workspaces and members", async () => {
    const store = createMemoryWorkspaceStore();
    await store.putWorkspace({ id: "senegal", displayName: "Senegal", createdBy: "root", createdAt: "1970-01-01T00:00:00Z" });
    expect((await store.getWorkspace("senegal"))?.displayName).toBe("Senegal");
    expect(await store.getWorkspace("nope")).toBeNull();

    await store.putMember(member("senegal", "u1", "curator"));
    expect((await store.getMember("senegal", "u1"))?.role).toBe("curator");
    await store.removeMember("senegal", "u1");
    expect(await store.getMember("senegal", "u1")).toBeNull();
  });

  it("membersOf scopes by workspace; membershipsForUser scopes by user", async () => {
    const store = createMemoryWorkspaceStore({
      members: [
        member("senegal", "u1", "admin"),
        member("senegal", "u2", "curator"),
        member("kenya", "u1", "approver"),
      ],
    });
    expect((await store.membersOf("senegal")).map((m) => m.userId)).toEqual(["u1", "u2"]);
    expect((await store.membersOf("kenya")).map((m) => m.userId)).toEqual(["u1"]);
    const u1Memberships = await store.membershipsForUser("u1");
    expect(u1Memberships.map((m) => `${m.workspace}:${m.role}`).sort()).toEqual(["kenya:approver", "senegal:admin"]);
  });

  it("putMember upserts (re-grant updates the role)", async () => {
    const store = createMemoryWorkspaceStore({ members: [member("senegal", "u1", "curator")] });
    await store.putMember(member("senegal", "u1", "approver"));
    expect((await store.membersOf("senegal")).length).toBe(1);
    expect((await store.getMember("senegal", "u1"))?.role).toBe("approver");
  });
});

describe("resolveMemberships", () => {
  it("collapses a user's rows into a { workspace: role } map", async () => {
    const store = createMemoryWorkspaceStore({
      members: [member("senegal", "u1", "admin"), member("kenya", "u1", "curator")],
    });
    expect(await resolveMemberships("u1", store)).toEqual({ senegal: "admin", kenya: "curator" });
    expect(await resolveMemberships("nobody", store)).toEqual({});
  });
});
