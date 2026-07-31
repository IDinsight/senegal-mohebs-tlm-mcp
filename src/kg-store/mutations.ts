// ── Module: kg-store · internal ──────────────────────────────────────────────
// Two-phase confirm framework for GRAPH mutations. A mutation is a pure
// function over {nodes, edges}; the framework layers dry-run/confirm plumbing
// on top so every new mutation gets:
//   • preview → shared confirm envelope + per-mutation diff + warnings + a
//     confirmation token; changes NO state.
//   • confirm → token check (base version still current, nonce unused,
//     mutation + args match the preview), lazy draft creation if needed,
//     apply to the DRAFT slot only.
//
// STAKES: graph mutations STAGE a draft edit that is only visible to
// generation after a SEPARATE publish step. This is intentionally different
// from the document tools, which write live. The confirm envelope's `action`
// field must carry that distinction verbatim — see envelope shape below.
//
// LAYERING: the framework works on the raw {nodes, edges} shape (see
// SerializedGraph in curriculum/store-bridge.ts, mirrored here to keep
// kg-store dependency-free). Curriculum-shaped mutations that need the
// CurriculumModel serialize/deserialize on top of this — not inside it.
//
// The empty `validate` seam declared here is what #6 fills to make write-safety
// rules block confirmation entirely (errors → no token, no confirm path).

import { createHash, randomBytes } from "node:crypto";
import { getKgStore } from "./adapter.js";
import { toAuditActor } from "./audit.js";
import { validateStructural } from "./validate.js";
import type { AuditRecord, DiffEntry, GraphDiff, MutationEdge, MutationGraph, MutationNode, Slot, StoredMeta, ValidationResult } from "./types.js";
export type { DiffEntry, GraphDiff, MutationEdge, MutationGraph, MutationNode, ValidationResult } from "./types.js";
import { currentActor, type Actor } from "../actor.js";
import { authorize, selfApproveAllowed, type AuthAction } from "../authz.js";
import { randomUUID } from "node:crypto";

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

// Confirm outcomes. `stale` covers every "base moved" case (pointer moved,
// published shifted while token was against published, draft shifted while
// token was against draft, or a draft appeared/disappeared under our feet).
// The caller is expected to retry with a fresh preview.
export type GraphApplyResult =
  | { phase: "apply"; ok: true; kind: "graphMutation"; applied: string; draftSlot: Slot; diff: GraphDiff }
  | { phase: "apply"; ok: false; kind: "graphMutation"; reason: "stale" | "replay" | "invalidToken" | "argsMismatch" | "mutationMismatch" | "unseeded"; message: string };

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

const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
};

const hashGraph = (g: MutationGraph): string => {
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
    return { m: c.m, a: c.a, k: c.k, v: c.v, n: c.n };
  } catch { return null; }
};

// In-memory one-time-use nonce ledger. Scoped to the process (Cloud Run runs
// with an instance cap, so this is safe for the current deployment). If we
// scale out, this becomes per-instance and a replay across instances is
// theoretically possible — a follow-up would move this onto the pointer doc.
const consumedNonces = new Set<string>();
export const __resetMutationsForTest = (): void => { consumedNonces.clear(); };

// ── Diff computation ─────────────────────────────────────────────────────────
// Simple id-keyed diff: added, removed, and changed (deep property inequality).
// The `changed` entries carry before/after for the whole node/edge object,
// which is easier for a UI to render than a per-field patch and still small
// enough (nodes/edges are shallow).

const byId = <T extends { id: string }>(xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]));

const stripSlot = <T extends { slot?: Slot }>(x: T): Omit<T, "slot"> => {
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
  // Always read the published slot separately so Rule 1's rename-detection has
  // a stable identity reference — the published snapshot is the source of
  // truth for "what ids belong to which content." If no draft exists,
  // targetSlot === publishedSlot and the two reads return identical graphs;
  // in that case the extra listNodes/listEdges pair is a modest re-read cost
  // (Firestore's small graph today) that keeps this branch dead-simple —
  // preferable to a "same slot? skip" special case that would drift.
  const [nodes, edges, meta, pubNodes, pubEdges] = await Promise.all([
    store.listNodes(namespace, targetSlot),
    store.listEdges(namespace, targetSlot),
    store.readMeta(namespace, targetSlot),
    store.listNodes(namespace, publishedSlot),
    store.listEdges(namespace, publishedSlot),
  ]);
  return {
    graph: { nodes: nodes.map(stripSlot), edges: edges.map(stripSlot) },
    kind: pointer.draftSlot ? "onDraft" : "onPublished",
    publishedSlot,
    meta,
    publishedGraph: { nodes: pubNodes.map(stripSlot), edges: pubEdges.map(stripSlot) },
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
  // Optional subject-aware coverage hook (#13). When provided, it is called on
  // the post-apply graph and its output is merged into the dry-run `warnings`.
  // Injected by the server layer from the active adapter's `coverageWarnings`
  // so kg-store stays subject-agnostic — the framework never knows what a
  // "chapter" or "bilan" is. Warnings NEVER block; they ride the normal preview
  // envelope exactly like a mutation's own validate warnings.
  coverage?: (graph: MutationGraph) => string[];
};

export async function runGraphMutation<Args>(
  input: RunGraphMutationArgs<Args>,
): Promise<GraphPreviewResult | GraphBlockedResult | GraphApplyResult | GraphUnauthorizedResult> {
  const { namespace, mutation, args, confirm, token, coverage } = input;
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
    if (!token) { await auditBlocked("invalidToken: missing"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "invalidToken", message: "confirm=true was passed without a confirmationToken; re-run without confirm to get a fresh preview." }; }
    const payload = decodeToken(token);
    if (!payload) { await auditBlocked("invalidToken: malformed"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "invalidToken", message: "confirmationToken is malformed; re-run without confirm to get a fresh preview." }; }
    if (payload.m !== mutation.name) { await auditBlocked(`mutationMismatch: token was for '${payload.m}'`); return { phase: "apply", ok: false, kind: "graphMutation", reason: "mutationMismatch", message: `confirmationToken was issued for mutation '${payload.m}', not '${mutation.name}'.` }; }
    if (payload.a !== hashArgs(args)) { await auditBlocked("argsMismatch"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "argsMismatch", message: "args differ from the previewed values; re-run without confirm to preview the new args." }; }
    if (consumedNonces.has(payload.n)) { await auditBlocked("replay"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "replay", message: "This confirmation token has already been used; a mutation cannot be applied twice from one preview." }; }

    const snap = await readBase(namespace);
    if ("unseeded" in snap) { await auditBlocked("unseeded"); return { phase: "apply", ok: false, kind: "graphMutation", reason: "unseeded", message: `Namespace '${namespace}' has no seed; run the seed before mutating.` }; }

    // A preview against 'published' expects (a) no draft has appeared since,
    // and (b) published hasn't shifted. A preview against 'draft' expects the
    // draft hash still matches. Any mismatch → stale, retry.
    if (snap.kind !== payload.k) {
      await auditBlocked(`stale: base slot changed (was '${payload.k}', now '${snap.kind}')`);
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", message: `The base slot changed since preview (was '${payload.k}', now '${snap.kind}'); re-preview.` };
    }
    if (hashGraph(snap.graph) !== payload.v) {
      await auditBlocked("stale: base graph changed");
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", message: `The base graph changed since preview; re-preview to see the current diff.` };
    }

    // Lazy draft creation. When the preview was against 'published' the draft
    // does not exist yet — createDraft is a byte-for-byte copy of published,
    // so the just-created draft equals what the preview mutated in memory
    // (already verified via the hash check above). The `createDraft` audit
    // rides its own transaction and is a distinct committed event.
    if (snap.kind === "onPublished") {
      const createRec: AuditRecord = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        actor: auditActor,
        namespace,
        eventType: "createDraft",
        baseVersion: hashGraph(snap.graph),
      };
      await store.createDraft(namespace, createRec);
    }
    const pointerAfter = await store.readPointer(namespace);
    if (!pointerAfter || !pointerAfter.draftSlot) {
      await auditBlocked("stale: draft could not be established");
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", message: `Draft could not be established for namespace '${namespace}'; re-preview.` };
    }
    const draftSlot = pointerAfter.draftSlot;

    // Re-read the draft (it's the exact bytes we hashed on the 'onDraft' path,
    // and the freshly-copied bytes on the 'onPublished' path). Apply the
    // mutation to it and writeSlot the new state.
    const [dn, de] = await Promise.all([store.listNodes(namespace, draftSlot), store.listEdges(namespace, draftSlot)]);
    const draftGraph: MutationGraph = { nodes: dn.map(stripSlot), edges: de.map(stripSlot) };
    const applied = mutation.apply(draftGraph, args);
    const diff = diffGraphs(draftGraph, applied);

    const resultingVersion = hashGraph(applied);
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
    // writeSlot commits the audit doc in the SAME final pointer transaction
    // (see firestore.ts) — a committed change always has its record.
    await store.writeSlot(namespace, draftSlot, { nodes: applied.nodes, edges: applied.edges, meta }, applyRec);

    // Consume the nonce LAST — if writeSlot throws, the token remains usable
    // for a legitimate retry after the operator fixes the underlying issue.
    consumedNonces.add(payload.n);
    return { phase: "apply", ok: true, kind: "graphMutation", applied: mutation.describe(args), draftSlot, diff };
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
  // Coverage warnings (#13) are subject-shaped completeness hints on the
  // PROPOSED result. They only inform — never gate the token — so they join
  // `warnings`, never `errors`. Computed on `after` so the curator sees the
  // consequence of THIS edit (e.g. "the chapter you just emptied has no bilan").
  const coverageWarnings = coverage ? coverage(after) : [];
  const errors = [...structural.errors, ...custom.errors];
  const warnings = [...structural.warnings, ...custom.warnings, ...coverageWarnings];
  if (errors.length > 0) {
    // Sample the first error for the reason field — the full array is
    // reflected in the response but audit records stay lightweight.
    await auditBlocked(`validation: ${errors[0]}`);
    return { phase: "blocked", needsConfirmation: false, kind: "graphMutation", errors, warnings };
  }

  const diff = diffGraphs(snap.graph, after);
  const issuedToken = encodeToken({
    m: mutation.name,
    a: hashArgs(args),
    k: snap.kind,
    v: hashGraph(snap.graph),
    n: randomBytes(16).toString("base64url"),
  });
  return {
    phase: "preview",
    needsConfirmation: true,
    kind: "graphMutation",
    action,
    message: `Do NOT proceed yet. Ask the user to confirm — about to ${action}. Once they explicitly agree, call this tool again with confirm: true AND the confirmationToken from this response.`,
    diff,
    warnings,
    confirmationToken: issuedToken,
  };
}

// ── Lifecycle wrappers: publishDraft / discardDraft ─────────────────────────
// These wrap the raw store lifecycle primitives so #8's role check and #7's
// audit both fire, atomically with the state write (the store commits both
// in one Firestore transaction). Tests and future user-facing tools (#9)
// go through these, NEVER `store.publishDraft` / `store.discardDraft`
// directly — that's how enforcement stays complete.

export type PublishResult =
  | { ok: true; publishedSlot: Slot; auditId: string; selfAuthored: boolean }
  | { ok: false; reason: string };

export type DiscardResult =
  | { ok: true; auditId: string; discardedApplyIds: string[] }
  | { ok: false; reason: string };

// Snapshot the actor and its audit-friendly projection. Same shape used by
// runGraphMutation — kept here rather than exported so the lifecycle
// wrappers don't reach into runGraphMutation's internals.
function snapshotActor(): { actor: Actor; auditActor: AuditRecord["actor"] } {
  const actor = currentActor();
  return { actor, auditActor: toAuditActor(actor) };
}

// The apply records that would be promoted by publishing / discarded by
// discarding the current draft. "Current draft" = everything since the
// most recent createDraft record for this namespace (that createDraft is
// what opened the draft the store is holding right now).
async function currentDraftApplies(namespace: string): Promise<AuditRecord[]> {
  const store = getKgStore();
  const events = await store.listAudit({ namespace });
  // listAudit is newest-first. The first createDraft we hit is the one
  // that opened the currently-open draft.
  const created = events.find((r) => r.eventType === "createDraft");
  if (!created) return []; // no draft ever created here — publish will fail at the store anyway
  return events.filter((r) => r.eventType === "apply" && r.ts >= created.ts);
}

// `warningsAtPublish` (optional, #13) is the coverage warnings the caller
// observed on the draft at publish time — recorded verbatim on the publish
// audit for traceability. It never affects the outcome (warnings don't block);
// the two-phase wrapper computes it and hands it down.
export async function publishDraft(namespace: string, warningsAtPublish?: string[]): Promise<PublishResult> {
  const store = getKgStore();
  const { actor, auditActor } = snapshotActor();

  // Denial → typed error + blocked audit + no state change. Same shape as
  // runGraphMutation's unauthorized path.
  const authz = authorize(actor, "publish", namespace);
  if (!authz.ok) {
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${authz.reason}`,
    });
    return { ok: false, reason: authz.reason };
  }

  // Look up which applies would be promoted, and check self-authorship.
  // The `selfAuthored` flag is ALWAYS recorded on the publish audit so an
  // auditor sees self-approval even when the config permits it (see #8
  // decision (b)); only if the strict config is set does self-authorship
  // block the publish.
  const promoted = await currentDraftApplies(namespace);
  const promotedIds = promoted.map((r) => r.id);
  const selfAuthored = promoted.some((r) => r.actor.id === actor.id);

  if (selfAuthored && !selfApproveAllowed()) {
    const reason = "separation-of-duties: approver cannot publish self-authored edits (TLM_ALLOW_SELF_APPROVE=0)";
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${reason}`,
    });
    return { ok: false, reason };
  }

  // Read the pointer so we can name the base/resulting versions. The
  // pointer flip is atomic in the store — we're just recording the two
  // hashes for later reference.
  const pointer = await store.readPointer(namespace);
  if (!pointer || !pointer.draftSlot) {
    // Not an authz failure — just no draft to promote. Let the store
    // surface it, but audit it as blocked for consistency.
    const reason = "no draft to publish";
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason,
    });
    return { ok: false, reason };
  }
  const [pubN, pubE, drN, drE] = await Promise.all([
    store.listNodes(namespace, pointer.publishedSlot),
    store.listEdges(namespace, pointer.publishedSlot),
    store.listNodes(namespace, pointer.draftSlot),
    store.listEdges(namespace, pointer.draftSlot),
  ]);
  const baseVersion = hashGraph({ nodes: pubN.map(stripSlot), edges: pubE.map(stripSlot) });
  const resultingVersion = hashGraph({ nodes: drN.map(stripSlot), edges: drE.map(stripSlot) });

  const auditId = randomUUID();
  const rec: AuditRecord = {
    id: auditId, ts: new Date().toISOString(), actor: auditActor,
    namespace, eventType: "publish",
    baseVersion, resultingVersion,
    promotedApplyIds: promotedIds,
    selfAuthored,
    // Record coverage warnings only when the caller computed them (they had a
    // coverage hook). Firestore rejects `undefined`, so omit the key entirely
    // rather than write undefined when none were supplied.
    ...(warningsAtPublish ? { warningsAtPublish } : {}),
  };
  await store.publishDraft(namespace, rec);
  const newPointer = await store.readPointer(namespace);
  return { ok: true, publishedSlot: newPointer!.publishedSlot, auditId, selfAuthored };
}

export async function discardDraft(namespace: string): Promise<DiscardResult> {
  const store = getKgStore();
  const { actor, auditActor } = snapshotActor();

  const authz = authorize(actor, "discard", namespace);
  if (!authz.ok) {
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${authz.reason}`,
    });
    return { ok: false, reason: authz.reason };
  }

  const promoted = await currentDraftApplies(namespace);
  const discardedApplyIds = promoted.map((r) => r.id);

  // Base version = published slot's hash at discard time. Nothing changes on
  // published, but recording the hash gives audit reviews a fixed anchor.
  const pointer = await store.readPointer(namespace);
  let baseVersion: string | undefined;
  if (pointer) {
    const [n, e] = await Promise.all([
      store.listNodes(namespace, pointer.publishedSlot),
      store.listEdges(namespace, pointer.publishedSlot),
    ]);
    baseVersion = hashGraph({ nodes: n.map(stripSlot), edges: e.map(stripSlot) });
  }

  const auditId = randomUUID();
  const rec: AuditRecord = {
    id: auditId, ts: new Date().toISOString(), actor: auditActor,
    namespace, eventType: "discard",
    baseVersion, discardedApplyIds,
  };
  await store.discardDraft(namespace, rec);
  return { ok: true, auditId, discardedApplyIds };
}

// ── Whole-draft diff (#9's diff_draft) ──────────────────────────────────────
// Walks published vs draft structurally, keyed by stable id. This is
// distinct from #5's per-mutation diff (returned by runGraphMutation) —
// per-mutation shows what ONE apply changed; whole-draft shows the
// cumulative diff of every edit that has landed on the current draft.
// Structural recompute is the source of truth per decision (a) — audit is
// a log, not a state oracle.
export type WholeDraftDiff = {
  hasDraft: boolean;
  publishedVersion?: string;
  draftVersion?: string;
  diff?: GraphDiff;
  // Coverage/consistency warnings over the WHOLE draft (#13). This is the
  // approver's pre-publish view — exactly where "this chapter has no bilan"
  // should surface. Present (possibly empty) whenever a draft exists and a
  // coverage hook was supplied; omitted when there's no draft. Warnings NEVER
  // block publish.
  warnings?: string[];
};

// `coverage` is the active adapter's subject-aware hook, injected by the server
// layer (same as runGraphMutation) so this function stays subject-agnostic.
// When omitted, no warnings are computed (callers that only need the diff).
export async function diffDraft(
  namespace: string,
  coverage?: (graph: MutationGraph) => string[],
): Promise<WholeDraftDiff> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer || !pointer.draftSlot) return { hasDraft: false };
  const [pubN, pubE, drN, drE] = await Promise.all([
    store.listNodes(namespace, pointer.publishedSlot),
    store.listEdges(namespace, pointer.publishedSlot),
    store.listNodes(namespace, pointer.draftSlot),
    store.listEdges(namespace, pointer.draftSlot),
  ]);
  const published: MutationGraph = { nodes: pubN.map(stripSlot), edges: pubE.map(stripSlot) };
  const draft: MutationGraph = { nodes: drN.map(stripSlot), edges: drE.map(stripSlot) };
  return {
    hasDraft: true,
    publishedVersion: hashGraph(published),
    draftVersion: hashGraph(draft),
    diff: diffGraphs(published, draft),
    warnings: coverage ? coverage(draft) : [],
  };
}

// ── Draft-level concurrency token for publish_draft / discard_draft ─────────
// Distinct from #5's per-mutation token — same self-describing receipt
// shape (base64url JSON, hash + nonce) but its own payload keys so one
// can't be replayed as the other. A dry-run mints a token capturing the
// draft version shown; confirm rejects if the draft moved since.
type DraftTokenPayload = {
  op: "publish" | "discard";
  ns: string;
  dv: string;   // hashGraph(draft) at dry-run time
  n: string;    // nonce
};

const encodeDraftToken = (p: DraftTokenPayload): string =>
  Buffer.from(JSON.stringify(p), "utf8").toString("base64url");

const decodeDraftToken = (token: string): DraftTokenPayload | null => {
  try {
    const p = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!p || typeof p !== "object") return null;
    const c = p as Record<string, unknown>;
    if (c.op !== "publish" && c.op !== "discard") return null;
    if (typeof c.ns !== "string" || typeof c.dv !== "string" || typeof c.n !== "string") return null;
    return { op: c.op, ns: c.ns, dv: c.dv, n: c.n };
  } catch { return null; }
};

// Second, sibling nonce ledger — keeps draft-level tokens in a separate
// space from #5's per-mutation nonces so the two lifetimes don't leak
// into each other. Same in-memory-per-process caveat.
const consumedDraftNonces = new Set<string>();
export const __resetDraftTokensForTest = (): void => { consumedDraftNonces.clear(); };

// ── publish_draft (two-phase) ────────────────────────────────────────────────
// Dry-run: authorize as publish → compute whole-draft diff → issue token,
// no state change. Confirm: authorize again → verify token + draft still
// current → delegate to publishDraft() which does the atomic promote +
// audit. The self-approve check runs inside publishDraft — no need to
// duplicate it here.
export type PublishConfirmPreview = {
  phase: "preview";
  kind: "publishDraft";
  needsConfirmation: true;
  action: string;
  message: string;
  hasDraft: boolean;
  publishedVersion?: string;
  draftVersion?: string;
  diff?: GraphDiff;
  warnings?: string[];          // coverage warnings on the draft (#13) — inform, never block
  confirmationToken?: string;   // absent when there's nothing to publish
};
export type PublishConfirmResult =
  | PublishConfirmPreview
  | { phase: "unauthorized"; kind: "publishDraft"; action: "publish"; reason: string }
  | { phase: "commit"; kind: "publishDraft"; ok: true; publishedSlot: Slot; auditId: string; selfAuthored: boolean; warningsAtPublish?: string[] }
  | { phase: "commit"; kind: "publishDraft"; ok: false; reason: string };

export async function publishDraftWithConfirm(
  namespace: string,
  opts: { confirm?: boolean; token?: string; coverage?: (graph: MutationGraph) => string[] } = {},
): Promise<PublishConfirmResult> {
  const store = getKgStore();
  const { actor, auditActor } = snapshotActor();

  // Authorize FIRST at both phases, so denials never leak the draft's diff.
  const authz = authorize(actor, "publish", namespace);
  if (!authz.ok) {
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${authz.reason}`,
    });
    return { phase: "unauthorized", kind: "publishDraft", action: "publish", reason: authz.reason };
  }

  // ── Confirm phase ───────────────────────────────────────────────────────
  if (opts.confirm) {
    if (!opts.token) return { phase: "commit", kind: "publishDraft", ok: false, reason: "confirm=true was passed without a confirmationToken; re-run without confirm to get a fresh preview." };
    const payload = decodeDraftToken(opts.token);
    if (!payload || payload.op !== "publish") return { phase: "commit", kind: "publishDraft", ok: false, reason: "confirmationToken is not valid for publish_draft; re-run without confirm to get a fresh one." };
    if (payload.ns !== namespace) return { phase: "commit", kind: "publishDraft", ok: false, reason: `confirmationToken was issued for namespace '${payload.ns}', not '${namespace}'.` };
    if (consumedDraftNonces.has(payload.n)) return { phase: "commit", kind: "publishDraft", ok: false, reason: "This confirmationToken has already been used." };

    // Draft-still-current check: recompute the draft hash and compare
    // against the token. If it moved (someone applied since dry-run),
    // reject — a stale publish could promote unexpected edits. Pass the
    // coverage hook so we can record the warnings-at-publish on the audit.
    const current = await diffDraft(namespace, opts.coverage);
    if (!current.hasDraft) return { phase: "commit", kind: "publishDraft", ok: false, reason: "no draft to publish" };
    if (current.draftVersion !== payload.dv) return { phase: "commit", kind: "publishDraft", ok: false, reason: "the draft moved since dry-run — re-preview to see the current diff before publishing" };

    // Delegate to the atomic primitive. It runs its own authz (redundant
    // but cheap and defence-in-depth) and its own self-approve check. The
    // warnings we observed are recorded on the publish audit — they never
    // block (approver's call), they annotate the trail.
    const warningsAtPublish = opts.coverage ? (current.warnings ?? []) : undefined;
    const result = await publishDraft(namespace, warningsAtPublish);
    consumedDraftNonces.add(payload.n);
    if (!result.ok) return { phase: "commit", kind: "publishDraft", ok: false, reason: result.reason };
    return { phase: "commit", kind: "publishDraft", ok: true, publishedSlot: result.publishedSlot, auditId: result.auditId, selfAuthored: result.selfAuthored, ...(warningsAtPublish ? { warningsAtPublish } : {}) };
  }

  // ── Dry-run phase ───────────────────────────────────────────────────────
  const snap = await diffDraft(namespace, opts.coverage);
  if (!snap.hasDraft) {
    // Nothing to publish. Return a preview envelope shape but with no token.
    return {
      phase: "preview", kind: "publishDraft", needsConfirmation: true,
      action: `publish namespace '${namespace}' — no draft exists, nothing to promote`,
      message: `There is no draft to publish for '${namespace}'. Make an edit first (upsert_property or similar), then dry-run publish_draft again.`,
      hasDraft: false,
    };
  }
  const token = encodeDraftToken({ op: "publish", ns: namespace, dv: snap.draftVersion!, n: randomBytes(16).toString("base64url") });
  const changeCount = (snap.diff!.nodes.added.length + snap.diff!.nodes.changed.length + snap.diff!.nodes.removed.length +
                       snap.diff!.edges.added.length + snap.diff!.edges.changed.length + snap.diff!.edges.removed.length);
  return {
    phase: "preview", kind: "publishDraft", needsConfirmation: true,
    action: `PROMOTE the draft on namespace '${namespace}' to LIVE (published) — ${changeCount} change(s) will be visible to generation immediately after this step`,
    message: `Do NOT proceed yet. Ask the user to confirm — about to promote ${changeCount} draft change(s) to published on '${namespace}'. Once they explicitly agree, call this tool again with confirm: true AND the confirmationToken from this response.`,
    hasDraft: true,
    publishedVersion: snap.publishedVersion,
    draftVersion: snap.draftVersion,
    diff: snap.diff,
    warnings: snap.warnings,
    confirmationToken: token,
  };
}

// ── discard_draft (two-phase) ────────────────────────────────────────────────
// Mirrors publish_draft's shape. Curator or approver may call.
export type DiscardConfirmPreview = {
  phase: "preview";
  kind: "discardDraft";
  needsConfirmation: true;
  action: string;
  message: string;
  hasDraft: boolean;
  draftVersion?: string;
  diff?: GraphDiff;
  confirmationToken?: string;
};
export type DiscardConfirmResult =
  | DiscardConfirmPreview
  | { phase: "unauthorized"; kind: "discardDraft"; action: "discard"; reason: string }
  | { phase: "commit"; kind: "discardDraft"; ok: true; auditId: string; discardedApplyIds: string[] }
  | { phase: "commit"; kind: "discardDraft"; ok: false; reason: string };

export async function discardDraftWithConfirm(
  namespace: string,
  opts: { confirm?: boolean; token?: string } = {},
): Promise<DiscardConfirmResult> {
  const store = getKgStore();
  const { actor, auditActor } = snapshotActor();

  const authz = authorize(actor, "discard", namespace);
  if (!authz.ok) {
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${authz.reason}`,
    });
    return { phase: "unauthorized", kind: "discardDraft", action: "discard", reason: authz.reason };
  }

  if (opts.confirm) {
    if (!opts.token) return { phase: "commit", kind: "discardDraft", ok: false, reason: "confirm=true was passed without a confirmationToken; re-run without confirm to get a fresh preview." };
    const payload = decodeDraftToken(opts.token);
    if (!payload || payload.op !== "discard") return { phase: "commit", kind: "discardDraft", ok: false, reason: "confirmationToken is not valid for discard_draft; re-run without confirm to get a fresh one." };
    if (payload.ns !== namespace) return { phase: "commit", kind: "discardDraft", ok: false, reason: `confirmationToken was issued for namespace '${payload.ns}', not '${namespace}'.` };
    if (consumedDraftNonces.has(payload.n)) return { phase: "commit", kind: "discardDraft", ok: false, reason: "This confirmationToken has already been used." };

    const current = await diffDraft(namespace);
    if (!current.hasDraft) return { phase: "commit", kind: "discardDraft", ok: false, reason: "no draft to discard" };
    if (current.draftVersion !== payload.dv) return { phase: "commit", kind: "discardDraft", ok: false, reason: "the draft moved since dry-run — re-preview before discarding" };

    const result = await discardDraft(namespace);
    consumedDraftNonces.add(payload.n);
    if (!result.ok) return { phase: "commit", kind: "discardDraft", ok: false, reason: result.reason };
    return { phase: "commit", kind: "discardDraft", ok: true, auditId: result.auditId, discardedApplyIds: result.discardedApplyIds };
  }

  const snap = await diffDraft(namespace);
  if (!snap.hasDraft) {
    return {
      phase: "preview", kind: "discardDraft", needsConfirmation: true,
      action: `discard the draft on namespace '${namespace}' — no draft exists, nothing to discard`,
      message: `There is no draft to discard for '${namespace}'.`,
      hasDraft: false,
    };
  }
  const token = encodeDraftToken({ op: "discard", ns: namespace, dv: snap.draftVersion!, n: randomBytes(16).toString("base64url") });
  const changeCount = (snap.diff!.nodes.added.length + snap.diff!.nodes.changed.length + snap.diff!.nodes.removed.length +
                       snap.diff!.edges.added.length + snap.diff!.edges.changed.length + snap.diff!.edges.removed.length);
  return {
    phase: "preview", kind: "discardDraft", needsConfirmation: true,
    action: `DISCARD ${changeCount} draft change(s) on namespace '${namespace}' — the draft will be thrown away and published is untouched`,
    message: `Do NOT proceed yet. Ask the user to confirm — about to DISCARD ${changeCount} draft change(s) on '${namespace}'. Once they explicitly agree, call this tool again with confirm: true AND the confirmationToken from this response.`,
    hasDraft: true,
    draftVersion: snap.draftVersion,
    diff: snap.diff,
    confirmationToken: token,
  };
}

// ── upsert_property mutation (#10) — the first real edit ────────────────────
// Edits ONE logical wording on ONE existing node. The curator supplies a
// LOGICAL key ("title" / "text" / "title_en" / "text_en"); the ADAPTER's
// wordingAliases (see src/types.ts::WordingAliases) resolves it to the
// concrete storage paths for that node's kind — typically both the
// normalized field (what presenters read) and the raw source (what
// preserves the source graph). All resolved paths are updated atomically
// in ONE mutation call, ONE audit entry — no drift risk from the curator
// forgetting a "second update."
//
// Safety, layered:
//   1. Adapter says WHICH logical keys apply on WHICH node kinds and WHERE
//      each is stored. Subject-specific knowledge, in subject code.
//   2. This mutation validates every resolved path against the central
//      SAFE_PATHS allowlist below — a rogue/careless adapter cannot
//      expand the pilot's editable surface by declaring an unsafe path.
//   3. Existing-key rule: every resolved path must currently hold a
//      non-null string on the node. The pilot fixes wording that's there;
//      it does not create new fields (that's #12's job).
//   4. #6's structural rules (id-immutable, no-orphan) still run over the
//      apply result at the framework level.

// The central safety allowlist. An adapter's wordingAliases MUST use paths
// from this set — if it declares anything else, upsertProperty rejects the
// call at validate time. Extending the pilot = adding to this set AND
// declaring the new alias on the adapter(s). Two edits, on purpose.
export const UPSERT_PROPERTY_SAFE_PATHS: ReadonlySet<string> = new Set([
  "title", "text",
  "raw.chapitreTitre", "raw.chapitreTitre_en",
  "raw.osTexte", "raw.osTexte_en",
  "raw.description", "raw.description_en",
]);

// Walk a dotted path over an object, returning the leaf value or undefined.
// Deliberately shallow — no array indexing, no bracket notation — since
// the allowlist paths are all dot-separated object keys.
// Exported so the recipes module (#14) can reuse the exact same path semantics
// for its structural-property edits instead of forking a second copy.
export function readAtPath(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// Return a new object with the leaf at `path` set to `value`, without
// mutating any input. Intermediate objects along the path are cloned;
// siblings are structurally shared.
// Exported for reuse by the recipes module (#14) — same reason as readAtPath.
export function writeAtPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split(".");
  const clone = { ...obj };
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    // The safety allowlist's paths always run through existing objects
    // (properties has 'raw', 'raw' has 'chapitreTitre', etc.). The
    // existing-key rule catches a truly-missing leaf earlier; the empty
    // fallback here is defence-in-depth.
    const nextObj = next && typeof next === "object" && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
    cur[seg] = nextObj;
    cur = nextObj;
  }
  cur[segments[segments.length - 1]] = value;
  return clone;
}

// Args carry the adapter's wordingAliases so the mutation (kg-store, layer 1)
// stays subject-agnostic — the server tool (layer 3) reads them from the
// active adapter and passes them through. See src/server/lifecycle.ts.
export type UpsertPropertyArgs = {
  nodeId: string;
  key: string;                 // logical wording key: "title" | "text" | "title_en" | "text_en" | …
  value: string;
  aliases: import("../types.js").WordingAliases;
};

export const upsertProperty: GraphMutation<UpsertPropertyArgs> = {
  name: "upsertProperty",
  describe: ({ nodeId, key }) => `update wording '${key}' on node '${nodeId}'`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (typeof args.value !== "string") {
      errors.push(`value must be a string (got ${typeof args.value})`);
      return { errors, warnings: [] };
    }
    const node = base.nodes.find((n) => n.id === args.nodeId);
    if (!node) {
      errors.push(`node '${args.nodeId}' not found in the draft`);
      return { errors, warnings: [] };
    }
    const aliasesForKind = args.aliases[node.type];
    if (!aliasesForKind) {
      errors.push(
        `node kind '${node.type}' has no editable wording in the active subject. ` +
        `The adapter does not declare any wordingAliases for this kind.`,
      );
      return { errors, warnings: [] };
    }
    const paths = aliasesForKind[args.key];
    if (!paths || paths.length === 0) {
      const available = Object.keys(aliasesForKind);
      errors.push(
        `wording key '${args.key}' is not editable on node kind '${node.type}'. ` +
        `Available keys: ${available.length ? available.join(", ") : "(none)"}.`,
      );
      return { errors, warnings: [] };
    }
    // Central safety allowlist. If an adapter declared a path outside the
    // pilot's approved set, reject — safety cannot rely on adapters being
    // careful.
    for (const path of paths) {
      if (!UPSERT_PROPERTY_SAFE_PATHS.has(path)) {
        errors.push(
          `storage path '${path}' is not on the pilot's safety allowlist ` +
          `(declared by the adapter for wording '${args.key}' on kind '${node.type}'). ` +
          `Extend UPSERT_PROPERTY_SAFE_PATHS in kg-store/mutations.ts to allow it.`,
        );
      }
    }
    if (errors.length > 0) return { errors, warnings: [] };
    // Existing-key rule: every resolved path must currently hold a non-null
    // string. Editing wording that's already there is the pilot; creating
    // new fields is not.
    for (const path of paths) {
      const current = readAtPath(node.properties, path);
      if (typeof current !== "string") {
        errors.push(
          `path '${path}' does not currently exist as text on node '${args.nodeId}' ` +
          `(current value: ${current === undefined ? "missing" : JSON.stringify(current)}). ` +
          `This pilot edits existing wording; it does not create new fields.`,
        );
      }
    }
    return { errors, warnings: [] };
  },
  apply: (base, args) => ({
    nodes: base.nodes.map((n) => {
      if (n.id !== args.nodeId) return n;
      const paths = args.aliases[n.type]?.[args.key] ?? [];
      let props = n.properties as Record<string, unknown>;
      for (const path of paths) {
        props = writeAtPath(props, path, args.value);
      }
      return { ...n, properties: props as typeof n.properties };
    }),
    edges: base.edges,
  }),
};
