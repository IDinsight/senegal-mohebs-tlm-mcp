// ── Module: authz (leaf) ─────────────────────────────────────────────────────
// Server-side authorization for graph state changes. One pure function called
// from every state-changing chokepoint (see runGraphMutation, publishDraft,
// discardDraft in kg-store/mutations.ts).
//
// Two guarantees:
//   1. Authorization derives ONLY from the verified `Actor.role` (a claim on
//      the verified Supabase JWT). No tool argument, header, or client-set
//      field influences the decision — same rule as identity itself.
//   2. Unknown actors and signed-in-but-no-role actors have no write role;
//      they can still read and generate (reads are ungated).
//
// Roles today (see actor.ts::Role):
//   curator  — may apply / dry-run mutations, may discard a draft.
//   approver — superset of curator; may also publish.
//
// `namespace` is accepted so per-namespace roles can slot in later (e.g. a
// curator for ci/maths but not ce1/reading) without touching call sites. It
// is unused today — role is global — and passing a namespace does not affect
// the decision in this step.

import type { Actor } from "./actor.js";

export type AuthAction = "apply" | "discard" | "publish" | "readDraft" | "readAudit";

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: string };

export function authorize(actor: Actor, action: AuthAction, _namespace: string): AuthResult {
  if (actor.unknown) {
    return { ok: false, reason: "no verified identity — sign in to make changes" };
  }
  if (!actor.role) {
    return { ok: false, reason: `signed in as '${actor.id}' but no role is assigned — ask an admin to add a row in Supabase 'user_roles'` };
  }
  switch (action) {
    case "apply":
    case "discard":
    case "readDraft":
      // Curator and approver both allowed. Approver is a superset — see
      // README "Curator / approver roles". readDraft (used by #9's
      // diff_draft tool) is the read side of the draft: same allow set,
      // since a draft is pre-publish work-in-progress that non-participants
      // shouldn't see.
      return { ok: true };
    case "publish":
      if (actor.role === "approver") return { ok: true };
      return { ok: false, reason: `role '${actor.role}' cannot publish — only 'approver' may promote a draft` };
    case "readAudit":
      // Reviewing the append-only audit trail is the approver's oversight
      // duty — same tier as publish. A curator authors edits but does not
      // review the log through the MCP in this version (may widen later).
      if (actor.role === "approver") return { ok: true };
      return { ok: false, reason: `role '${actor.role}' cannot read the audit log — only 'approver' may review the trail` };
  }
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
