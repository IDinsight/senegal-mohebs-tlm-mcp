/*
 * Module: kg-store · internal
 *
 * Two-phase confirm framework for GRAPH mutations. A mutation is a pure
 * function over {nodes, edges}; the framework layers dry-run/confirm plumbing
 * on top so every new mutation gets:
 *   • preview → shared confirm envelope + per-mutation diff + warnings + a
 *     confirmation token; changes NO state.
 *   • confirm → token check (base version still current, nonce unused,
 *     mutation + args match the preview), lazy draft creation if needed,
 *     apply to the DRAFT slot only.
 *
 * STAKES: graph mutations STAGE a draft edit that is only visible to
 * generation after a SEPARATE publish step. This is intentionally different
 * from the document tools, which write live. The confirm envelope's `action`
 * field must carry that distinction verbatim — see envelope shape below.
 *
 * LAYERING: the framework works on the raw {nodes, edges} shape (see
 * SerializedGraph in curriculum/store-bridge.ts, mirrored here to keep
 * kg-store dependency-free). Curriculum-shaped mutations that need the
 * CurriculumModel serialize/deserialize on top of this — not inside it.
 *
 * The empty `validate` seam declared here is what #6 fills to make write-safety
 * rules block confirmation entirely (errors → no token, no confirm path).
 */

import { createHash, randomBytes } from "node:crypto";
import { getKgStore } from "./adapter.js";
import { toAuditActor } from "./audit.js";
import { validateStructural } from "./validate.js";
import type { AuditRecord, DiffEntry, GraphDiff, MutationEdge, MutationGraph, MutationNode, Slot, SlotDelta, StoredMeta, ValidationResult } from "./types.js";
export type { DiffEntry, GraphDiff, MutationEdge, MutationGraph, MutationNode, ValidationResult } from "./types.js";
import { currentActor } from "../actor.js";
import { authorize, type AuthAction } from "../authz.js";
import { randomUUID } from "node:crypto";
import { timed, timedSync } from "../utils/index.js";

// A graph mutation is a pure function over {nodes, edges}. `describe(args)` is
// used in the envelope's `action` string, so it must state the stakes: what
// changes on the DRAFT, and remind the caller that publish is a separate step.
//
// `validate` receives BOTH the pre-state and the post-apply graph — the
// framework computes `after` before validation so structural checks (see
// validateStructural) and mutation-specific checks alike can inspect the
// proposed result, not just intent. It's optional: every mutation gets the
// two shared structural rules for free, whether or not it adds its own.
export interface GraphMutation<Args> {
  name: string;
  describe(args: Args): string;
  validate?(base: MutationGraph, after: MutationGraph, args: Args): ValidationResult;
  apply(base: MutationGraph, args: Args): MutationGraph;
}

// (Per-mutation diff shape — `DiffEntry` / `GraphDiff` — lives in types.ts so
// audit.ts can reference it without cycling through this module. Re-exported
// above.)

// Return-type union for runGraphMutation. Discriminated on `phase` so callers
// can narrow without probing `in` operators. `phase: "preview"` and `"blocked"`
// share the common (needsConfirmation / action / message) fields with the
// document tools' envelope; `phase: "apply"` returns the effect of a confirm.
export type GraphPreviewResult = {
  phase: "preview";
  needsConfirmation: true;
  kind: "graphMutation";
  action: string;
  message: string;
  diff: GraphDiff;
  warnings: string[];
  confirmationToken: string;
  // Absolute expiry of the token (ISO-8601). After this instant a confirm is
  // rejected as TOKEN_EXPIRED *only if the base is otherwise unchanged*; a moved
  // base still reports STALE_TOKEN first. Surfaced so the caller knows how long
  // it has to get the user's approval before needing a fresh dry-run.
  expiresAt: string;
  // True when the args were PARKED server-side (a large payload on a caller that
  // opted in) — the confirm needs ONLY confirm:true + the token, no payload
  // re-send. False on the normal re-send path. Surfaced so a tool/UI can tell the
  // model it need not regenerate the payload.
  payloadStored: boolean;
};

// What a validation-blocked dry-run returns instead. No token: confirm has
// nothing to replay against errors. `warnings` are still surfaced so callers
// can present them alongside the block reason.
export type GraphBlockedResult = {
  phase: "blocked";
  needsConfirmation: false;
  kind: "graphMutation";
  errors: string[];
  warnings: string[];
};

// Confirm outcomes. Two "retry" families the caller must tell apart:
//   • STALE_TOKEN (`reason:"stale"`) — the base graph MOVED since preview
//     (someone edited): the diff you approved no longer applies, so re-preview
//     and RE-REVIEW the new diff.
//   • TOKEN_EXPIRED (`reason:"expired"`) — the token simply aged past its TTL
//     while the base is UNCHANGED: nothing substantive changed, just re-run the
//     dry-run to get a fresh token.
// Every failure carries a stable `code` (issue #3's typed-error vocabulary)
// alongside the legacy `reason`. `idempotent:true` marks a successful result
// that was REPLAYED from the idempotency cache rather than freshly applied.
export type GraphApplyFailCode =
  | "STALE_TOKEN" | "TOKEN_EXPIRED" | "REPLAY" | "INVALID_TOKEN" | "ARGS_MISMATCH" | "MUTATION_MISMATCH" | "UNSEEDED";
export type GraphApplyResult =
  | { phase: "apply"; ok: true; kind: "graphMutation"; applied: string; draftSlot: Slot; diff: GraphDiff; auditId: string; idempotent?: boolean }
  | { phase: "apply"; ok: false; kind: "graphMutation"; reason: "stale" | "expired" | "replay" | "invalidToken" | "argsMismatch" | "mutationMismatch" | "unseeded"; code: GraphApplyFailCode; message: string };

// A distinct result for role-denied calls. Kept separate from `blocked`
// (which stays for validation errors from #6) and from `apply ok:false`
// (which stays for stale/replay/token errors from #5) so callers can tell
// "you can't do this at all" from "you can do this but not right now".
export type GraphUnauthorizedResult = {
  phase: "unauthorized";
  kind: "graphMutation";
  action: AuthAction;
  reason: string;
};

// ── Base-version computation ─────────────────────────────────────────────────
// The base version is a sha256 over the sorted-canonical JSON of the graph's
// nodes+edges. Sorting by id (both nodes and edges have stable ids) makes it
// robust against Firestore's non-guaranteed query order — the same logical
// graph always hashes to the same string.

// Exported so config-flow.ts can hash a profile record the same order-stable
// way (Firestore doesn't guarantee object key order on read-back).
export const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
};

// Exported for the publish/discard lifecycle (publish-flow.ts), which needs the
// same content hash to name base/resulting versions and detect a moved draft.
export const hashGraph = (g: MutationGraph): string => {
  // Strip any accidental slot tags (readers might hand us StoredNode with the
  // slot field already stamped) so two graphs that differ only in slot don't
  // hash differently — the mutation cares about content, not storage tag.
  const nodes = [...g.nodes].map(({ ...n }) => { delete (n as { slot?: Slot }).slot; return n; })
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...g.edges].map(({ ...e }) => { delete (e as { slot?: Slot }).slot; return e; })
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(stableStringify({ nodes, edges })).digest("hex");
};

const hashArgs = (args: unknown): string =>
  createHash("sha256").update(stableStringify(args)).digest("hex");

// ── Token encoding ───────────────────────────────────────────────────────────
// Opaque to callers; the server treats it as a self-describing preview
// receipt. No signature: forgery isn't a threat model here because a forged
// token still has to match the current server state (base version) to be
// accepted, and mismatch always reduces to a `stale` retry.
type TokenPayload = {
  m: string;   // mutation name
  a: string;   // hashArgs(args)
  k: "onDraft" | "onPublished"; // which base the diff was computed against
  v: string;   // hashGraph(base) at preview time
  n: string;   // nonce (one-time use)
  exp: number; // absolute expiry, epoch ms (issue #4 TTL)
  // How the confirm gets its args. "resend" (the default, and the shape older
  // tokens carry) → the caller re-sends the args and they must hash to `a`.
  // "stored" → the args were PARKED at dry-run under nonce `n`; the confirm reads
  // them back instead of the caller re-sending. `a` stays the integrity pin in
  // both modes (it equals the parked payload's hash under "stored").
  mode?: "resend" | "stored";
};

// Token time-to-live. State-based validation (the `v` hash) is still the
// PRIMARY guard — a slow round-trip or restart never invalidates a token while
// the underlying graph is unchanged. The TTL is a secondary bound so a token
// left lying around eventually forces a fresh dry-run. Override with
// TLM_CONFIRM_TTL_MS; default 15 minutes. Read lazily (not memoised) so the
// override can be toggled per-test in one run.
function tokenTtlMs(): number {
  const raw = Number(process.env.TLM_CONFIRM_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
}

// Payload size (bytes of the serialized args) at or above which the dry-run
// PARKS the payload server-side and issues a "stored" token, so the confirm need
// not re-send it. Below it, the payload rides the confirm as before (re-send +
// args-hash). One framework-level switch, not a per-tool allowlist: it captures
// exactly the tools whose payloads are big enough to be worth not regenerating
// (a whole profile record, a content-heavy authoring batch) and leaves the tiny
// structural edits (move/reposition/delete) on the cheap re-send path. Override
// with TLM_CONFIRM_STORE_BYTES; default 4 KB. Exported so config-flow uses the
// same threshold. Read lazily so a test can toggle it per-run.
export function pendingStoreThresholdBytes(): number {
  const raw = Number(process.env.TLM_CONFIRM_STORE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 4096;
}

// TTL of a parked payload. Kept in step with the token TTL — the entry only has
// to outlive the window between dry-run and confirm, the same window the token
// governs. A read past this treats the entry as absent (→ fresh dry-run).
export const pendingTtlMs = tokenTtlMs;

// Serialize args once and decide whether they cross the store threshold.
export const shouldStorePayload = (args: unknown): boolean =>
  stableStringify(args).length >= pendingStoreThresholdBytes();

// Extract the one-time nonce from a confirmationToken. Exported so a WRAPPER
// tool (server/wrapper-park.ts) can key its own parked context off the same
// nonce the framework mints — one round-trip, no separate id space to invent.
// Returns null when the token isn't a well-formed graph-mutation token; a caller
// that also needs to know it's a graph token can inspect the return via
// runGraphMutation later — this helper is deliberately minimal.
export const readTokenNonce = (token: string): string | null => {
  const payload = decodeToken(token);
  return payload ? payload.n : null;
};

const encodeToken = (p: TokenPayload): string =>
  Buffer.from(JSON.stringify(p), "utf8").toString("base64url");

const decodeToken = (token: string): TokenPayload | null => {
  try {
    const p = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!p || typeof p !== "object") return null;
    const c = p as Record<string, unknown>;
    if (typeof c.m !== "string" || typeof c.a !== "string" || typeof c.v !== "string" || typeof c.n !== "string") return null;
    if (c.k !== "onDraft" && c.k !== "onPublished") return null;
    // `exp` is required on tokens this build issues; tolerate its absence
    // (treat as non-expiring) so an in-flight token from an older build isn't
    // rejected as malformed across a rolling deploy.
    const exp = typeof c.exp === "number" ? c.exp : Number.POSITIVE_INFINITY;
    // A token minted before this field existed is a re-send token by definition.
    const mode = c.mode === "stored" ? "stored" : "resend";
    return { m: c.m, a: c.a, k: c.k, v: c.v, n: c.n, exp, mode };
  } catch { return null; }
};

// In-memory one-time-use nonce ledger. Scoped to the process (Cloud Run runs
// with an instance cap, so this is safe for the current deployment). If we
// scale out, this becomes per-instance and a replay across instances is
// theoretically possible — a follow-up would move this onto the pointer doc.
const consumedNonces = new Set<string>();

// Idempotency ledger (issue #4). When a caller passes an `idempotencyKey`, the
// SUCCESSFUL apply result is cached under it; a retried confirm with the same
// key returns that cached result verbatim (marked `idempotent:true`) instead
// of re-applying or erroring. This is what makes a confirm safe to retry after
// a network blip that lost the response — the double-apply is prevented, and
// the caller gets a clear success rather than a confusing "replay" rejection.
// Same process-scoped caveat as the nonce ledger; a restart clears it, after
// which the base-hash CAS still prevents any double-apply (a landed edit moved
// the base, so the retry reports STALE_TOKEN — safe, if less friendly).
const idempotentResults = new Map<string, GraphApplyResult>();
export const __resetMutationsForTest = (): void => { consumedNonces.clear(); idempotentResults.clear(); };

// ── Diff computation ─────────────────────────────────────────────────────────
// Simple id-keyed diff: added, removed, and changed (deep property inequality).
// The `changed` entries carry before/after for the whole node/edge object,
// which is easier for a UI to render than a per-field patch and still small
// enough (nodes/edges are shallow).

const byId = <T extends { id: string }>(xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]));

// Exported alongside hashGraph for publish-flow.ts's slot-agnostic reads.
export const stripSlot = <T extends { slot?: Slot }>(x: T): Omit<T, "slot"> => {
  const { slot: _s, ...rest } = x;
  return rest;
};

function diffSide<T extends { id: string; slot?: Slot }>(before: T[], after: T[]): { added: DiffEntry[]; removed: DiffEntry[]; changed: DiffEntry[] } {
  const b = byId(before), a = byId(after);
  const added: DiffEntry[] = [], removed: DiffEntry[] = [], changed: DiffEntry[] = [];
  for (const [id, next] of a) {
    const prev = b.get(id);
    if (!prev) { added.push({ id, after: stripSlot(next) }); continue; }
    if (stableStringify(stripSlot(prev)) !== stableStringify(stripSlot(next))) {
      changed.push({ id, before: stripSlot(prev), after: stripSlot(next) });
    }
  }
  for (const [id, prev] of b) if (!a.has(id)) removed.push({ id, before: stripSlot(prev) });
  return { added, removed, changed };
}

export const diffGraphs = (before: MutationGraph, after: MutationGraph): GraphDiff => ({
  nodes: diffSide(before.nodes, after.nodes),
  edges: diffSide(before.edges, after.edges),
});

// ── Base-graph read ──────────────────────────────────────────────────────────
// Preview reads DRAFT if it exists (that's the surface the confirm will mutate),
// otherwise PUBLISHED (which becomes the draft's starting point on confirm).
// The `kind` tells confirm which invariant to re-check.

type BaseSnapshot = {
  graph: MutationGraph;             // the slot we'll compute the diff / apply against
  kind: "onDraft" | "onPublished";  // which slot classification `graph` came from
  publishedSlot: Slot;
  meta: StoredMeta | null;
  publishedGraph: MutationGraph;    // ALWAYS the current published slot — Rule 1's reference
};

async function readBase(namespace: string): Promise<BaseSnapshot | { unseeded: true }> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer) return { unseeded: true };
  const targetSlot = pointer.draftSlot ?? pointer.publishedSlot;
  const publishedSlot = pointer.publishedSlot;
  // Rule 1's rename-detection needs the published snapshot as the identity
  // reference. When a draft exists, target and published are different slots, so
  // read both. When there's NO draft, target === published: reading it twice
  // would fetch the exact same docs, so we read once and share the result for
  // both `graph` and `publishedGraph`. (On a ~2,000-node graph that redundant
  // pair was a full extra fetch per preview/confirm — see the timing findings.)
  const onDraft = pointer.draftSlot != null;
  const [nodes, edges, meta, pubNodes, pubEdges] = await Promise.all([
    store.listNodes(namespace, targetSlot),
    store.listEdges(namespace, targetSlot),
    store.readMeta(namespace, targetSlot),
    onDraft ? store.listNodes(namespace, publishedSlot) : Promise.resolve(null),
    onDraft ? store.listEdges(namespace, publishedSlot) : Promise.resolve(null),
  ]);
  const graph = { nodes: nodes.map(stripSlot), edges: edges.map(stripSlot) };
  return {
    graph,
    kind: onDraft ? "onDraft" : "onPublished",
    publishedSlot,
    meta,
    // No draft → published IS target; reuse the graph we already read.
    publishedGraph: onDraft ? { nodes: pubNodes!.map(stripSlot), edges: pubEdges!.map(stripSlot) } : graph,
  };
}

// ── The framework entry point ────────────────────────────────────────────────
// One call handles both phases. Callers pass `confirm` (falsy on preview) and,
// on confirm, the token returned from the preview.

export type RunGraphMutationArgs<Args> = {
  namespace: string;
  mutation: GraphMutation<Args>;
  args: Args;
  confirm?: boolean;
  token?: string;
  // Optional idempotency key (issue #4). When set on a confirm, a retry with
  // the same key returns the first apply's cached result instead of re-applying
  // — a safe no-op after a lost-response retry. Omit it and confirm keeps its
  // strict one-time-token behaviour (a replay is rejected).
  idempotencyKey?: string;
  // Opt in to parking a LARGE payload server-side so the confirm need not re-send
  // it (token-only confirm). Only callers that pass their COMPLETE args straight
  // through — no wrapper that rebuilds args or mints ids per phase — should set
  // this; a batch/minting wrapper must park at its own layer instead. When set,
  // parking still only kicks in above the size threshold; small payloads keep the
  // re-send path regardless.
  storePayload?: boolean;
};

export async function runGraphMutation<Args>(
  input: RunGraphMutationArgs<Args>,
): Promise<GraphPreviewResult | GraphBlockedResult | GraphApplyResult | GraphUnauthorizedResult> {
  const { namespace, mutation, args, confirm, token, idempotencyKey, storePayload } = input;
  const store = getKgStore();

  // Compose the stakes-accurate action string exactly once. Every path that
  // surfaces an envelope pulls from here so the "stages a draft edit, publish
  // is a separate step" phrasing can't drift between preview and confirm.
  const action = `${mutation.describe(args)} — this STAGES a draft edit on namespace '${namespace}'; nothing reaches generation until you separately publish the draft`;

  // Snapshot the actor once for this call — every audit record we emit uses
  // the same identity. `unknown` is a valid state (see #1); we record it
  // verbatim rather than fabricating a fake actor. Role is snapshot too so
  // audit reviews see WHO WAS a curator/approver when this happened.
  const actor = currentActor();
  const auditActor = toAuditActor(actor);

  // Small helper: emit one blocked-attempt audit record. Fire-and-forget from
  // the caller's perspective — but we `await` it so a store failure surfaces
  // rather than being swallowed. Blocked records carry no diff or versions;
  // eventType alone distinguishes them from committed changes.
  const auditBlocked = async (reason: string): Promise<void> => {
    await store.appendAudit({
      id: randomUUID(),
      ts: new Date().toISOString(),
      actor: auditActor,
      namespace,
      eventType: "blocked",
      mutation: mutation.name,
      reason,
    });
  };

  // ── Authorization: must be a curator or approver to apply — for BOTH
  // dry-run and confirm. Reads/generation stay ungated elsewhere; this gate
  // is only for graph state changes. Enforced BEFORE any state read or
  // token check, so denials never leak diffs or issue tokens.
  const authz = authorize(actor, "apply", namespace);
  if (!authz.ok) {
    await auditBlocked(`unauthorized: ${authz.reason}`);
    return { phase: "unauthorized", kind: "graphMutation", action: "apply", reason: authz.reason };
  }

  // ── Confirm phase ────────────────────────────────────────────────────────
  if (confirm) {
    if (!token) { await auditBlocked("invalidToken: missing"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "invalidToken", code: "INVALID_TOKEN", message: "confirm=true was passed without a confirmationToken; re-run without confirm to get a fresh preview." }; }
    const payload = decodeToken(token);
    if (!payload) { await auditBlocked("invalidToken: malformed"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "invalidToken", code: "INVALID_TOKEN", message: "confirmationToken is malformed; re-run without confirm to get a fresh preview." }; }
    if (payload.m !== mutation.name) { await auditBlocked(`mutationMismatch: token was for '${payload.m}'`); return { phase: "apply", ok: false, kind: "graphMutation", reason: "mutationMismatch", code: "MUTATION_MISMATCH", message: `confirmationToken was issued for mutation '${payload.m}', not '${mutation.name}'.` }; }

    // In "resend" mode the caller's args must still hash to the previewed value.
    // Kept BEFORE idempotency (a key must never mask a mismatched retry) and
    // before the replay guard, matching the original order. "stored"-mode args are
    // resolved AFTER the replay guard below (a replayed stored token whose parked
    // payload was already deleted must report the replay, not a "payload missing").
    if (payload.mode !== "stored" && payload.a !== hashArgs(args)) {
      await auditBlocked("argsMismatch");
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "argsMismatch", code: "ARGS_MISMATCH", message: "args differ from the previewed values; re-run without confirm to preview the new args." };
    }

    // Idempotency (issue #4): a retry carrying the SAME idempotencyKey returns
    // the first apply's cached result — a safe no-op — BEFORE the one-time-nonce
    // check below would reject it as a replay. Checked after the mutation/args
    // guards so a key can never mask a mismatched retry.
    if (idempotencyKey != null && idempotentResults.has(idempotencyKey)) {
      const cached = idempotentResults.get(idempotencyKey)!;
      return cached.ok ? { ...cached, idempotent: true } : cached;
    }

    if (consumedNonces.has(payload.n)) { await auditBlocked("replay"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "replay", code: "REPLAY", message: "This confirmation token has already been used; a mutation cannot be applied twice from one preview. (Pass an idempotencyKey on confirm to make a retried confirm a safe no-op instead.)" }; }

    // Resolve "stored"-mode args now that the replay guard has passed. The dry-run
    // parked them under the nonce; read them back (the caller re-sent nothing, so
    // we do NOT re-hash the incoming args — for graph tools a token-only confirm
    // legitimately carries only a partial arg shape). A missing parked entry is
    // STALE — the safe outcome is a fresh dry-run, never a guess.
    let effectiveArgs = args;
    if (payload.mode === "stored") {
      const parked = await store.readPending(namespace, payload.n);
      if (!parked) { await auditBlocked("stale: parked payload missing"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", code: "STALE_TOKEN", message: "The previewed payload has expired or was already used; re-run without confirm to preview again." }; }
      if (parked.proposedHash !== payload.a) { await auditBlocked("argsMismatch: parked payload"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "argsMismatch", code: "ARGS_MISMATCH", message: "the parked payload does not match the token; re-run without confirm to preview again." }; }
      effectiveArgs = parked.payload as Args;
    }

    const snap = await timed("confirm.readBase", () => readBase(namespace));
    if ("unseeded" in snap) { await auditBlocked("unseeded"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "unseeded", code: "UNSEEDED", message: `Namespace '${namespace}' has no seed; run the seed before mutating.` }; }

    // STALE takes priority over EXPIRED: a moved base means the approved diff no
    // longer applies (re-REVIEW), which is more important than "token aged out".
    // A preview against 'published' expects (a) no draft has appeared since, and
    // (b) published hasn't shifted. A preview against 'draft' expects the draft
    // hash still matches. Any mismatch → STALE_TOKEN, re-preview.
    if (snap.kind !== payload.k) {
      await auditBlocked(`stale: base slot changed (was '${payload.k}', now '${snap.kind}')`);
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", code: "STALE_TOKEN", message: `The base slot changed since preview (was '${payload.k}', now '${snap.kind}'); re-preview to review the new diff.` };
    }
    if (hashGraph(snap.graph) !== payload.v) {
      await auditBlocked("stale: base graph changed");
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", code: "STALE_TOKEN", message: `The base graph changed since preview; re-preview to review the current diff.` };
    }
    // Base is UNCHANGED — only now does TTL matter. Expiry with an unchanged
    // base is purely a timing signal: re-run the dry-run for a fresh token; the
    // diff you'd approve is identical.
    if (Date.now() > payload.exp) {
      await auditBlocked("expired: token past TTL");
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "expired", code: "TOKEN_EXPIRED", message: "The confirmationToken has expired (base unchanged); re-run without confirm to get a fresh token — the diff will be the same." };
    }

    // Lazy draft creation. When the preview was against 'published' the draft
    // does not exist yet — createDraft opens an empty overlay on published
    // (O(1), no copy), so the just-created draft reads identical to published,
    // which is what the preview mutated in memory (verified via the hash check
    // above). The `createDraft` audit rides its own transaction, a distinct event.
    if (snap.kind === "onPublished") {
      const createRec: AuditRecord = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        actor: auditActor,
        namespace,
        eventType: "createDraft",
        baseVersion: hashGraph(snap.graph),
      };
      await timed("confirm.createDraft", () => store.createDraft(namespace, createRec));
    }
    const pointerAfter = await store.readPointer(namespace);
    if (!pointerAfter || !pointerAfter.draftSlot) {
      await auditBlocked("stale: draft could not be established");
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", code: "STALE_TOKEN", message: `Draft could not be established for namespace '${namespace}'; re-preview.` };
    }
    const draftSlot = pointerAfter.draftSlot;

    // Resolve the draft graph the mutation applies to.
    //
    // On the 'onDraft' path, readBase already read THIS draft into snap.graph,
    // and the base-version CAS above proved it is current (its hash still equals
    // the token's) — so a second full read of the same slot is pure redundancy.
    // Reuse snap.graph and skip the re-read; on a ~2,000-node graph that trims a
    // full-graph fetch (~2–3s co-located) off every follow-up edit. The residual
    // window (a concurrent confirm landing between readBase and applyDelta) is
    // the same order the framework already tolerates — serialized confirms are
    // enforced by the one-time nonce + base-version CAS, not by this re-read.
    //
    // On the 'onPublished' path we MUST re-read: createDraft may have accepted a
    // concurrently-created draft rather than the copy we just staged, so the
    // draft slot is the only source of truth for what we're about to edit.
    let draftGraph: MutationGraph;
    if (snap.kind === "onDraft") {
      draftGraph = snap.graph;
    } else {
      const [dn, de] = await timed("confirm.reReadDraft", () => Promise.all([store.listNodes(namespace, draftSlot), store.listEdges(namespace, draftSlot)]));
      draftGraph = { nodes: dn.map(stripSlot), edges: de.map(stripSlot) };
    }
    const applied = timedSync("confirm.applyFold", () => mutation.apply(draftGraph, effectiveArgs));
    const diff = timedSync("confirm.diffGraphs", () => diffGraphs(draftGraph, applied));

    const resultingVersion = timedSync("confirm.hashApplied", () => hashGraph(applied));
    const meta: StoredMeta = {
      // adapterId survives from the previous meta so re-seed detection stays
      // meaningful; contentHash + counts reflect the new draft state.
      adapterId: snap.meta?.adapterId ?? "unknown",
      seededAt: snap.meta?.seededAt ?? "unknown",
      contentHash: resultingVersion,
      nodeCount: applied.nodes.length,
      edgeCount: applied.edges.length,
    };
    const applyRec: AuditRecord = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      actor: auditActor,
      namespace,
      eventType: "apply",
      mutation: mutation.name,
      baseVersion: hashGraph(draftGraph),
      resultingVersion,
      diff,
    };
    // Turn the diff into a write delta: upsert the added + changed docs, delete
    // the removed ids. We pull the upsert payloads from `applied` (the diff
    // entries carry `after` as `unknown`, but `applied` is the typed post-state)
    // so the write stays O(edit size), not O(graph).
    const appliedNodeById = byId(applied.nodes);
    const appliedEdgeById = byId(applied.edges);
    const pick = <T,>(entries: DiffEntry[], from: Map<string, T>): T[] =>
      entries.map((e) => from.get(e.id)).filter((v): v is T => v !== undefined);
    const delta: SlotDelta = {
      upsertNodes: pick([...diff.nodes.added, ...diff.nodes.changed], appliedNodeById),
      upsertEdges: pick([...diff.edges.added, ...diff.edges.changed], appliedEdgeById),
      removeNodeIds: diff.nodes.removed.map((e) => e.id),
      removeEdgeIds: diff.edges.removed.map((e) => e.id),
    };
    // applyDelta commits the audit doc in the SAME final pointer transaction
    // (see firestore.ts) — a committed change always has its record.
    await timed("confirm.applyDelta", () => store.applyDelta(namespace, draftSlot, delta, meta, applyRec));

    // Consume the nonce LAST — if applyDelta throws, the token remains usable
    // for a legitimate retry after the operator fixes the underlying issue.
    consumedNonces.add(payload.n);
    // Best-effort cleanup of the parked payload now that it's applied. The nonce
    // ledger already blocks a replay, so a failed delete only leaves an orphan
    // for the TTL to sweep — never a correctness issue.
    if (payload.mode === "stored") { try { await store.deletePending(namespace, payload.n); } catch { /* swept by TTL */ } }
    const result: GraphApplyResult = { phase: "apply", ok: true, kind: "graphMutation", applied: mutation.describe(effectiveArgs), draftSlot, diff, auditId: applyRec.id };
    // Record the success under the idempotency key (if any) so a retried confirm
    // returns THIS result rather than re-applying. Set together with the nonce
    // so "nonce consumed" always implies "result cached" — no window where a
    // retry sees a used nonce but finds no cached success.
    if (idempotencyKey != null) idempotentResults.set(idempotencyKey, result);
    return result;
  }

  // ── Preview phase ────────────────────────────────────────────────────────
  const snap = await readBase(namespace);
  if ("unseeded" in snap) {
    await auditBlocked("unseeded (preview)");
    return { phase: "blocked", needsConfirmation: false, kind: "graphMutation", errors: [`Namespace '${namespace}' has no seed; run the seed before mutating.`], warnings: [] };
  }

  // Compute the post-apply graph FIRST — the shared structural rules (and
  // any mutation-specific validate) inspect the proposed result, not just
  // the intent. Apply is a pure in-memory function over the draft graph.
  const after = mutation.apply(snap.graph, args);

  // Two layers of validation, always in this order:
  //   1. The shared structural rules (id-immutable, no-orphan). Every
  //      mutation gets these, whether or not it defines its own validate.
  //      Rule 1's reference is PUBLISHED — cross-mutation rename attempts
  //      (delete X, then create-under-a-new-id with X's content) don't
  //      pair up inside a single mutation's diff, so the check compares
  //      the proposed state against published for a whole-draft view.
  //   2. The mutation's own validate, if any — for anything the mutation
  //      alone can decide. Receives (base = draft-just-before-this-mutation,
  //      after, args) — the local pre-mutation state, which is what
  //      mutation-specific rules typically need.
  // Errors from either layer block confirmation; per #5's contract we
  // return them via a `phase: "blocked"` result with NO token.
  const structural = validateStructural(snap.publishedGraph, after);
  const custom = mutation.validate
    ? mutation.validate(snap.graph, after, args)
    : { errors: [], warnings: [] };
  const errors = [...structural.errors, ...custom.errors];
  const warnings = [...structural.warnings, ...custom.warnings];
  if (errors.length > 0) {
    // Sample the first error for the reason field — the full array is
    // reflected in the response but audit records stay lightweight.
    await auditBlocked(`validation: ${errors[0]}`);
    return { phase: "blocked", needsConfirmation: false, kind: "graphMutation", errors, warnings };
  }

  const diff = diffGraphs(snap.graph, after);
  const expMs = Date.now() + tokenTtlMs();
  const nonce = randomBytes(16).toString("base64url");

  // Park the payload when the caller opted in AND it's big enough to be worth
  // not re-sending. Below the threshold we keep the re-send path (the token's
  // `a` hash), which avoids a store write on the common small edit.
  const stored = (storePayload ?? false) && shouldStorePayload(args);
  if (stored) {
    await store.putPending(namespace, nonce, {
      op: mutation.name,
      proposedHash: hashArgs(args),
      payload: args,
      expiresAt: expMs,
    });
  }

  const issuedToken = encodeToken({
    m: mutation.name,
    a: hashArgs(args),
    k: snap.kind,
    v: hashGraph(snap.graph),
    n: nonce,
    exp: expMs,
    mode: stored ? "stored" : "resend",
  });
  const confirmHint = stored
    ? "call this tool again with ONLY confirm: true AND the confirmationToken — the payload is held server-side, do NOT re-send it."
    : "call this tool again with confirm: true AND the confirmationToken from this response.";
  return {
    phase: "preview",
    needsConfirmation: true,
    kind: "graphMutation",
    action,
    message: `Do NOT proceed yet. Ask the user to confirm — about to ${action}. Once they explicitly agree, ${confirmHint}`,
    diff,
    warnings,
    confirmationToken: issuedToken,
    expiresAt: new Date(expMs).toISOString(),
    payloadStored: stored,
  };
}
