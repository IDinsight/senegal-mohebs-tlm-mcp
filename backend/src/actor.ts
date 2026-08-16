/*
 * Module: actor (leaf)
 *
 * Request-scoped identity of the caller. Populated ONLY by the HTTP entry from
 * the verified auth layer (Supabase JWT → `req.auth.extra`), and read by tool
 * handlers via `currentActor()`. Tool arguments, request bodies, and custom
 * headers are never trusted for identity — the whole surface for setting the
 * actor is `resolveActor(auth)` below, so a later change (e.g. flipping the
 * unknown-actor policy or adding roles) happens in one place.
 *
 * This is step 1 of a larger roadmap (curator/approver roles, audit log,
 * draft/published split). Everything downstream will build on this — do not
 * add spoofable inputs here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { superAdmins } from "./config.js";

/**
 * Roles a user can hold *inside a workspace*, stored in the Firestore membership
 * registry (see src/workspaces/ + docs/design-notes/workspaces.md). Each is a
 * strict superset of the one before it:
 *   curator  — apply / dry-run mutations, discard a draft.
 *   approver — superset of curator; may also publish.
 *   admin    — superset of approver; may also manage the workspace's members.
 */
export type MembershipRole = "curator" | "approver" | "admin";

/**
 * The role that actually decides an action: a workspace membership role, or the
 * cross-workspace `super_admin` tier (env-rooted, see config.superAdmins()).
 */
export type EffectiveRole = MembershipRole | "super_admin";

/** @deprecated Legacy single-tenant role from the Supabase `app_role` claim.
 *  Kept as a migration bridge; see `Actor.role`. */
export type Role = "curator" | "approver";

export interface Actor {
  /** Stable, verified id — the JWT `sub` claim. `"unknown"` iff `unknown === true`. */
  readonly id: string;
  /** Human-readable label, JWT `email` if present. Never used for auth decisions. */
  readonly email?: string;
  /** Verified issuer that produced this identity (JWT `iss`). */
  readonly tokenIssuer?: string;
  /**
   * LEGACY global role from the verified `app_role` JWT claim. Authoritative
   * authorization now comes from `memberships`; this only grants the named role
   * in the DEFAULT_WORKSPACE, as a migration bridge for users whose Supabase
   * role hasn't been copied into the membership registry yet. Never populated
   * from anything but the verified token.
   */
  readonly role?: Role;
  /**
   * True iff this verified identity is listed in TLM_SUPER_ADMINS (by `sub` or
   * `email`). Universal rights across every workspace. Set in resolveActor from
   * env (not spoofable — the id/email come from the verified token).
   */
  readonly superAdmin?: boolean;
  /**
   * Per-workspace roles from the Firestore membership registry, keyed by
   * workspace id. Empty from resolveActor (identity is sync + I/O-free); the
   * app layer fills it via withMemberships() after one membership read. Absent
   * ⇒ no memberships (fail-closed). Never from tool args/headers.
   */
  readonly memberships?: Readonly<Record<string, MembershipRole>>;
  /** True when no verified identity could be established for this request. */
  readonly unknown: boolean;
}

export const UNKNOWN_ACTOR: Actor = Object.freeze({ id: "unknown", unknown: true, superAdmin: false, memberships: {} });

const als = new AsyncLocalStorage<Actor>();

export const runAsActor = <T>(actor: Actor, fn: () => T): T => als.run(actor, fn);

/** The actor for the current request, or UNKNOWN_ACTOR outside of a run. */
export const currentActor = (): Actor => als.getStore() ?? UNKNOWN_ACTOR;

/**
 * TEST-ONLY: install an ambient actor for the current async context via
 * `AsyncLocalStorage.enterWith`. Persists through subsequent awaited work in
 * this task tree. Use in vitest `beforeEach` to give every test in a file a
 * default identity (e.g. a curator) without wrapping every `it` body in
 * `runAsActor`. Passing `null` resets to the empty store — subsequent
 * `currentActor()` calls fall back to UNKNOWN_ACTOR.
 *
 * NOT for production code: `runAsActor` is the only sanctioned writer at
 * runtime. This helper exists so tests don't have to boilerplate.
 */
export function __setActorForTest(actor: Actor | null): void {
  if (actor === null) als.enterWith(UNKNOWN_ACTOR);
  else als.enterWith(actor);
}

/**
 * Map the verified auth info attached by the bearer middleware to an Actor.
 * Accepts a structurally-typed argument (`{ extra?: { sub?, email?, iss? } }`)
 * so we don't couple to the MCP SDK's private types. All fields are checked to
 * be strings — a hostile or malformed `req.auth` cannot inject non-string state.
 *
 * SECURITY: this is the ONLY writer for actor state. It intentionally takes
 * `auth` — the object populated by the signature-verified bearer middleware —
 * and NEVER a request body, tool arguments, or client-settable headers.
 */
export function resolveActor(
  auth: { extra?: { sub?: unknown; email?: unknown; iss?: unknown; app_role?: unknown } } | undefined,
): Actor {
  const sub = auth?.extra?.sub;
  if (typeof sub !== "string" || sub.length === 0) return UNKNOWN_ACTOR;
  const email = typeof auth?.extra?.email === "string" ? auth.extra.email : undefined;
  const tokenIssuer = typeof auth?.extra?.iss === "string" ? auth.extra.iss : undefined;
  // `app_role` comes from the Supabase Custom Access Token Hook (see
  // scripts/supabase-user-roles.sql) which reads `public.user_roles` and
  // injects the value at token-mint time. Anything else — an "app_role"
  // field in the request body, a header, a tool argument — is ignored:
  // `auth.extra` is only populated by the signature-verified middleware.
  const rawRole = auth?.extra?.app_role;
  const role: Role | undefined = rawRole === "curator" || rawRole === "approver" ? rawRole : undefined;
  // Super-admin is env-rooted (config.superAdmins()) and matched against the
  // VERIFIED id/email only — reading env is I/O-free, so identity stays sync.
  const admins = superAdmins();
  const superAdmin = admins.includes(sub.toLowerCase()) || (email ? admins.includes(email.toLowerCase()) : false);
  return { id: sub, email, tokenIssuer, role, superAdmin, memberships: {}, unknown: false };
}

/**
 * Attach the caller's per-workspace memberships to an already-resolved identity.
 * Pure — the app layer reads the membership registry (async I/O) and calls this,
 * keeping resolveActor + authz free of any store dependency. Super-admin status
 * is preserved from the base actor.
 */
export function withMemberships(base: Actor, memberships: Readonly<Record<string, MembershipRole>>): Actor {
  return { ...base, memberships };
}
