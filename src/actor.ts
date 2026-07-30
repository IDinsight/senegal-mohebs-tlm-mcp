// ── Module: actor (leaf) ─────────────────────────────────────────────────────
// Request-scoped identity of the caller. Populated ONLY by the HTTP entry from
// the verified auth layer (Supabase JWT → `req.auth.extra`), and read by tool
// handlers via `currentActor()`. Tool arguments, request bodies, and custom
// headers are never trusted for identity — the whole surface for setting the
// actor is `resolveActor(auth)` below, so a later change (e.g. flipping the
// unknown-actor policy or adding roles) happens in one place.
//
// This is step 1 of a larger roadmap (curator/approver roles, audit log,
// draft/published split). Everything downstream will build on this — do not
// add spoofable inputs here.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Server-side authorization roles. Delivered as the `app_role` claim on the
 * verified Supabase JWT (see the Custom Access Token Hook in
 * scripts/supabase-user-roles.sql). NEVER read from tool args or a
 * client-set header — only from the JWT payload the auth middleware
 * verified. See src/authz.ts for the check policy.
 *
 * `curator`  — may apply / dry-run mutations, may discard a draft.
 * `approver` — superset of curator; may also publish a draft to published.
 */
export type Role = "curator" | "approver";

export interface Actor {
  /** Stable, verified id — the JWT `sub` claim. `"unknown"` iff `unknown === true`. */
  readonly id: string;
  /** Human-readable label, JWT `email` if present. Never used for auth decisions. */
  readonly email?: string;
  /** Verified issuer that produced this identity (JWT `iss`). */
  readonly tokenIssuer?: string;
  /**
   * Authorization role from the verified `app_role` JWT claim. `undefined`
   * for signed-in users who don't have a `user_roles` row in Supabase yet
   * — they can read/generate but not mutate/publish. Never populated from
   * anything but the verified token.
   */
  readonly role?: Role;
  /** True when no verified identity could be established for this request. */
  readonly unknown: boolean;
}

export const UNKNOWN_ACTOR: Actor = Object.freeze({ id: "unknown", unknown: true });

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
  return { id: sub, email, tokenIssuer, role, unknown: false };
}
