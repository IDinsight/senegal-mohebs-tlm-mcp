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

export interface Actor {
  /** Stable, verified id — the JWT `sub` claim. `"unknown"` iff `unknown === true`. */
  readonly id: string;
  /** Human-readable label, JWT `email` if present. Never used for auth decisions. */
  readonly email?: string;
  /** Verified issuer that produced this identity (JWT `iss`). */
  readonly tokenIssuer?: string;
  /** True when no verified identity could be established for this request. */
  readonly unknown: boolean;
}

export const UNKNOWN_ACTOR: Actor = Object.freeze({ id: "unknown", unknown: true });

const als = new AsyncLocalStorage<Actor>();

export const runAsActor = <T>(actor: Actor, fn: () => T): T => als.run(actor, fn);

/** The actor for the current request, or UNKNOWN_ACTOR outside of a run. */
export const currentActor = (): Actor => als.getStore() ?? UNKNOWN_ACTOR;

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
  auth: { extra?: { sub?: unknown; email?: unknown; iss?: unknown } } | undefined,
): Actor {
  const sub = auth?.extra?.sub;
  if (typeof sub !== "string" || sub.length === 0) return UNKNOWN_ACTOR;
  const email = typeof auth?.extra?.email === "string" ? auth.extra.email : undefined;
  const tokenIssuer = typeof auth?.extra?.iss === "string" ? auth.extra.iss : undefined;
  return { id: sub, email, tokenIssuer, unknown: false };
}
