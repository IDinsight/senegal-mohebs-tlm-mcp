/*
 * Pure-logic tests for the authorize() function
 *
 * The check is a small function over the Actor shape — testable directly with
 * no I/O, no store, no framework. Integration tests (that the framework and
 * the lifecycle wrappers actually CALL authorize) live in
 * src/kg-store/authz-enforcement.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { authorize, selfApproveAllowed } from "./authz.js";
import { UNKNOWN_ACTOR, type Actor } from "./actor.js";

const curator: Actor = { id: "c-1", role: "curator", unknown: false };
const approver: Actor = { id: "a-1", role: "approver", unknown: false };
const signedInNoRole: Actor = { id: "u-1", email: "u@example.com", unknown: false };
const NS = "test/ns";

describe("authorize — role matrix", () => {
  it("unknown actor is denied every action", () => {
    for (const action of ["apply", "discard", "publish"] as const) {
      const r = authorize(UNKNOWN_ACTOR, action, NS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/no verified identity/i);
    }
  });

  it("signed-in-but-no-role is denied every action (a signed-in user must be granted a row in user_roles)", () => {
    for (const action of ["apply", "discard", "publish"] as const) {
      const r = authorize(signedInNoRole, action, NS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/no role is assigned/i);
    }
  });

  it("curator can apply and discard but NOT publish", () => {
    expect(authorize(curator, "apply", NS).ok).toBe(true);
    expect(authorize(curator, "discard", NS).ok).toBe(true);
    const r = authorize(curator, "publish", NS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/only 'approver'/i);
  });

  it("approver can do everything a curator can, plus publish (superset)", () => {
    expect(authorize(approver, "apply", NS).ok).toBe(true);
    expect(authorize(approver, "discard", NS).ok).toBe(true);
    expect(authorize(approver, "publish", NS).ok).toBe(true);
  });

  it("the reason string names the actor's id when they're signed in without a role (so admins know who to grant)", () => {
    const r = authorize(signedInNoRole, "apply", NS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("u-1");
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
    // Only "0" strictly denies — anything else keeps the permissive default.
    expect(selfApproveAllowed()).toBe(true);
  });
});
