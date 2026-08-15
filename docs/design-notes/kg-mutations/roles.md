## Step 0 findings for #8 — curator / approver roles

### Supabase role-delivery path

Chosen: **`public.user_roles` table + Custom Access Token Hook**. The
Supabase Auth Hooks feature is available on this project (confirmed via
the dashboard). The hook function reads `user_roles` at token-mint time
and injects `app_role: "curator" | "approver"` into the JWT. The MCP
reads that claim in `resolveActor`.

SQL + docs: `scripts/supabase-user-roles.sql`. Enable the hook once in
Dashboard → Authentication → Hooks. Seed the first approver row via SQL
editor. No MCP tool grants roles — self-escalation surface is zero.

### Wiring point

- `Actor.role?: "curator" | "approver"` — new field on the actor,
  populated only in `resolveActor` from the verified `app_role` claim.
- `authorize(actor, action, namespace)` — pure function in
  [`src/authz.ts`](../../../src/authz.ts). Takes `namespace` even though roles
  are global today, so per-namespace roles slot in later without changing
  call sites.
- Enforcement chokepoints: `runGraphMutation` (both dry-run and confirm),
  `publishDraft` wrapper, `discardDraft` wrapper — all in
  [`src/kg-store/mutations.ts`](../../../src/kg-store/mutations.ts).

### Decisions (a)–(d) — as implemented

**(a) GLOBAL role scope.** Scalar `app_role` claim, no per-namespace
dimension. `authorize(actor, action, namespace)` accepts a namespace so
per-namespace can slot in later by changing the claim to
`app_roles: [{namespace, role}, ...]` and updating the single function.

**(b) Self-approve ALLOWED by default, marked in the audit.**
`TLM_ALLOW_SELF_APPROVE=0` flips it to strict. Every publish audit
record carries `selfAuthored: boolean` regardless of the flag.

**(c) Assignment in Supabase, out of the MCP surface.** SQL script
seeds the table + hook function; further grants happen in the Supabase
SQL editor. Enforced by a structural test — no exported symbol looks
like `grantRole` / `setRole` / etc.

**(d) Dry-run also requires curator.** A non-curator has no legitimate
reason to preview edits. Reads and generation stay ungated — an unknown
actor can still call `namespace_stats`, `walk_graph`,
`get_generation_context`, etc.

### Denial shape

New `phase: "unauthorized"` return from `runGraphMutation`, distinct
from `phase: "blocked"` (validation errors, #6) and `phase: "apply"
ok:false` (stale/replay tokens, #5). Every denial writes one `blocked`
audit record whose `reason` starts with `"unauthorized: ..."`. No token
is issued; no state changes.

---
