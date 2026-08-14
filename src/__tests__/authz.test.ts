/*
 * Pure-logic tests for authorize() — now PER WORKSPACE.
 *
 * The check is a small function over the Actor shape — testable directly with
 * no I/O, no store, no framework. Integration tests (that the framework and
 * the lifecycle wrappers actually CALL authorize) live in
 * src/kg-store/authz-enforcement.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { authorize, authorizeWorkspace, effectiveRole, workspaceOf, selfApproveAllowed } from "../authz.js";
import { UNKNOWN_ACTOR, type Actor } from "../actor.js";
import { DEFAULT_WORKSPACE } from "../config.js";

// Namespaces are `<workspace>/<grade>/<subject>`; the workspace is the first
// segment. DEFAULT_WORKSPACE ("senegal") is where the legacy app_role bridge
// applies; "kenya" is a second tenant nobody below is a member of by default.
const SEN = `${DEFAULT_WORKSPACE}/ci/maths`;
const KEN = "kenya/ci/maths";

const curator: Actor = { id: "c-1", unknown: false, memberships: { [DEFAULT_WORKSPACE]: "curator" } };
const approver: Actor = { id: "a-1", unknown: false, memberships: { [DEFAULT_WORKSPACE]: "approver" } };
const admin: Actor = { id: "ad-1", unknown: false, memberships: { [DEFAULT_WORKSPACE]: "admin" } };
const superAdmin: Actor = { id: "s-1", unknown: false, superAdmin: true };
const kenyaCurator: Actor = { id: "k-1", unknown: false, memberships: { kenya: "curator" } };
const legacyCurator: Actor = { id: "leg-1", unknown: false, role: "curator" }; // app_role bridge
const signedInNoRole: Actor = { id: "u-1", email: "u@example.com", unknown: false };

describe("workspaceOf", () => {
  it("extracts the first segment", () => {
    expect(workspaceOf(SEN)).toBe(DEFAULT_WORKSPACE);
    expect(workspaceOf(KEN)).toBe("kenya");
  });
});

describe("authorize — no identity / no role", () => {
  it("unknown actor is denied every action", () => {
    for (const action of ["apply", "discard", "publish", "manageMembers", "manageWorkspace"] as const) {
      const result = authorize(UNKNOWN_ACTOR, action, SEN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/no verified identity/i);
      }
    }
  });

  it("signed-in-but-no-membership is denied, naming the workspace and the id", () => {
    const result = authorize(signedInNoRole, "apply", SEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no role is assigned/i);
      expect(result.reason).toContain(DEFAULT_WORKSPACE);
      expect(result.reason).toContain("u-1");
    }
  });
});

describe("authorize — the tier ladder (within a workspace)", () => {
  it("curator: apply/discard yes; publish/readAudit/manage no", () => {
    expect(authorize(curator, "apply", SEN).ok).toBe(true);
    expect(authorize(curator, "discard", SEN).ok).toBe(true);
    expect(authorize(curator, "readDraft", SEN).ok).toBe(true);
    expect(authorize(curator, "publish", SEN).ok).toBe(false);
    expect(authorize(curator, "readAudit", SEN).ok).toBe(false);
    expect(authorize(curator, "manageMembers", SEN).ok).toBe(false);
  });

  it("approver: adds publish + readAudit; still no member management", () => {
    expect(authorize(approver, "publish", SEN).ok).toBe(true);
    expect(authorize(approver, "readAudit", SEN).ok).toBe(true);
    expect(authorize(approver, "manageMembers", SEN).ok).toBe(false);
  });

  it("admin: adds member management; not workspace creation", () => {
    expect(authorize(admin, "publish", SEN).ok).toBe(true);
    expect(authorize(admin, "manageMembers", SEN).ok).toBe(true);
    const result = authorize(admin, "manageWorkspace", SEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/super admin/i);
    }
  });

  it("super admin: everything, everywhere", () => {
    for (const ns of [SEN, KEN]) {
      for (const action of ["apply", "publish", "readAudit", "manageMembers", "manageWorkspace"] as const) {
        expect(authorize(superAdmin, action, ns).ok).toBe(true);
      }
    }
  });
});

describe("authorize — workspace isolation", () => {
  it("a Senegal curator has NO rights in Kenya", () => {
    const result = authorize(curator, "apply", KEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("kenya");
    }
  });

  it("a Kenya curator has NO rights in Senegal", () => {
    expect(authorize(kenyaCurator, "apply", SEN).ok).toBe(false);
    expect(authorize(kenyaCurator, "apply", KEN).ok).toBe(true);
  });
});

describe("authorize — legacy app_role bridge (migration)", () => {
  it("a legacy global role grants that role in DEFAULT_WORKSPACE only", () => {
    expect(authorize(legacyCurator, "apply", SEN).ok).toBe(true);   // bridges to senegal
    expect(authorize(legacyCurator, "publish", SEN).ok).toBe(false); // curator, not approver
    expect(authorize(legacyCurator, "apply", KEN).ok).toBe(false);   // not in kenya
  });
});

describe("effectiveRole", () => {
  it("super_admin wins over any membership", () => {
    expect(effectiveRole(superAdmin, "kenya")).toBe("super_admin");
  });
  it("membership beats legacy, legacy only in default workspace", () => {
    expect(effectiveRole(curator, DEFAULT_WORKSPACE)).toBe("curator");
    expect(effectiveRole(legacyCurator, DEFAULT_WORKSPACE)).toBe("curator");
    expect(effectiveRole(legacyCurator, "kenya")).toBeUndefined();
    expect(effectiveRole(signedInNoRole, DEFAULT_WORKSPACE)).toBeUndefined();
  });
});

describe("authorizeWorkspace — admin actions without a grade/subject", () => {
  it("routes through the same policy on the bare workspace", () => {
    expect(authorizeWorkspace(admin, "manageMembers", DEFAULT_WORKSPACE).ok).toBe(true);
    expect(authorizeWorkspace(curator, "manageMembers", DEFAULT_WORKSPACE).ok).toBe(false);
    expect(authorizeWorkspace(superAdmin, "manageWorkspace", "kenya").ok).toBe(true);
    expect(authorizeWorkspace(admin, "manageWorkspace", DEFAULT_WORKSPACE).ok).toBe(false);
  });
});

describe("selfApproveAllowed — env-flag defaults", () => {
  const prev = process.env.TLM_ALLOW_SELF_APPROVE;
  afterEach(() => {
    if (prev === undefined) delete process.env.TLM_ALLOW_SELF_APPROVE;
    else process.env.TLM_ALLOW_SELF_APPROVE = prev;
  });

  it("defaults to allowed when the env is unset", () => {
    delete process.env.TLM_ALLOW_SELF_APPROVE;
    expect(selfApproveAllowed()).toBe(true);
  });

  it('denies self-approve only when set to the exact string "0"', () => {
    process.env.TLM_ALLOW_SELF_APPROVE = "0";
    expect(selfApproveAllowed()).toBe(false);
    process.env.TLM_ALLOW_SELF_APPROVE = "1";
    expect(selfApproveAllowed()).toBe(true);
    process.env.TLM_ALLOW_SELF_APPROVE = "false";
    expect(selfApproveAllowed()).toBe(true);
  });
});
