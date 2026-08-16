/*
 * Admin-tool behaviour: authorization tiers, the last-admin guardrail, and the
 * audit trail. Drives the exported *Op functions directly with an injected
 * actor (currentActor via __setActorForTest) + memory stores — the same style
 * as capabilities.test.ts, since the admin tools read the verified actor and the
 * InMemory transport doesn't carry one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWorkspaceOp, addMemberOp, removeMemberOp, listMembersOp, listWorkspacesOp } from "../workspaces.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import { __setWorkspaceStoreForTest, createMemoryWorkspaceStore } from "../../workspaces/index.js";
import type { WorkspaceStore } from "../../workspaces/index.js";
import { __setKgStoreForTest, createMemoryKgStore } from "../../kg-store/index.js";

const SUPER: Actor = { id: "root", unknown: false, superAdmin: true };
const SEN_ADMIN: Actor = { id: "adm", unknown: false, memberships: { senegal: "admin" } };
const SEN_CURATOR: Actor = { id: "cur", unknown: false, memberships: { senegal: "curator" } };

let workspaceStore: WorkspaceStore;
let kgStore: ReturnType<typeof createMemoryKgStore>;

beforeEach(() => {
  workspaceStore = createMemoryWorkspaceStore({
    workspaces: [{ id: "senegal", displayName: "Senegal", createdBy: "seed", createdAt: "1970-01-01T00:00:00Z" }],
    members: [{ workspace: "senegal", userId: "adm", role: "admin", grantedBy: "seed", grantedAt: "1970-01-01T00:00:00Z" }],
  });
  kgStore = createMemoryKgStore();
  __setWorkspaceStoreForTest(workspaceStore);
  __setKgStoreForTest(kgStore);
});
afterEach(() => {
  __setActorForTest(null);
  __setWorkspaceStoreForTest(null);
  __setKgStoreForTest(null);
});

describe("create_workspace — super admin only", () => {
  it("super admin creates a workspace + writes an audit record", async () => {
    __setActorForTest(SUPER);
    const result = await createWorkspaceOp({ id: "Kenya", displayName: "Kenya" });
    expect(result.ok).toBe(true);
    expect(await workspaceStore.getWorkspace("kenya")).toMatchObject({ id: "kenya", displayName: "Kenya", createdBy: "root" });
    const audit = await kgStore.listAudit({ namespace: "kenya", eventType: "workspace" });
    expect(audit).toHaveLength(1);
    expect(audit[0].reason).toContain("created workspace 'kenya'");
  });

  it("a workspace admin cannot create a workspace", async () => {
    __setActorForTest(SEN_ADMIN);
    const result = await createWorkspaceOp({ id: "kenya", displayName: "Kenya" });
    expect(result.ok).toBe(false); // denied — not a super admin
    expect(String(result.error)).toMatch(/super admin|no role/i);
    expect(await workspaceStore.getWorkspace("kenya")).toBeNull();
  });

  it("rejects a duplicate id", async () => {
    __setActorForTest(SUPER);
    const result = await createWorkspaceOp({ id: "senegal", displayName: "dup" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/already exists/i);
  });
});

describe("add_member — admin tier", () => {
  it("a workspace admin grants a role in their workspace", async () => {
    __setActorForTest(SEN_ADMIN);
    const result = await addMemberOp({ workspace: "senegal", userId: "u1", role: "curator", email: "u1@x" });
    expect(result.ok).toBe(true);
    expect((await workspaceStore.getMember("senegal", "u1"))?.role).toBe("curator");
    const audit = await kgStore.listAudit({ namespace: "senegal", eventType: "membership" });
    expect(audit[0].reason).toContain("granted 'curator' to u1");
  });

  it("a curator cannot grant roles", async () => {
    __setActorForTest(SEN_CURATOR);
    const result = await addMemberOp({ workspace: "senegal", userId: "u1", role: "curator" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/manage members/i);
  });

  it("a Senegal admin has no rights in another workspace", async () => {
    __setActorForTest(SUPER);
    await createWorkspaceOp({ id: "kenya", displayName: "Kenya" });
    __setActorForTest(SEN_ADMIN);
    const result = await addMemberOp({ workspace: "kenya", userId: "u1", role: "curator" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/no role is assigned in workspace 'kenya'/i);
  });
});

describe("remove_member — last-admin guard", () => {
  it("refuses to remove the only admin", async () => {
    __setActorForTest(SUPER);
    const result = await removeMemberOp({ workspace: "senegal", userId: "adm" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/last admin/i);
  });

  it("allows removing an admin once a second admin exists", async () => {
    __setActorForTest(SUPER);
    await addMemberOp({ workspace: "senegal", userId: "adm2", role: "admin" });
    const result = await removeMemberOp({ workspace: "senegal", userId: "adm" });
    expect(result.ok).toBe(true);
    expect(await workspaceStore.getMember("senegal", "adm")).toBeNull();
  });

  it("removing a non-admin is unguarded", async () => {
    __setActorForTest(SUPER);
    await addMemberOp({ workspace: "senegal", userId: "u1", role: "curator" });
    const result = await removeMemberOp({ workspace: "senegal", userId: "u1" });
    expect(result.ok).toBe(true);
  });
});

describe("list — visibility", () => {
  it("list_members requires admin", async () => {
    __setActorForTest(SEN_CURATOR);
    expect((await listMembersOp({ workspace: "senegal" })).ok).toBe(false);
    __setActorForTest(SEN_ADMIN);
    const result = await listMembersOp({ workspace: "senegal" });
    expect((result.members as unknown[]).length).toBe(1);
  });

  it("list_workspaces shows super admin everything", async () => {
    __setActorForTest(SUPER);
    const result = await listWorkspacesOp();
    expect(result.superAdmin).toBe(true);
    expect((result.workspaces as Array<{ id: string }>).some((w) => w.id === "senegal")).toBe(true);
  });
});
