/*
 * Module: server · batched-mutation response shaping + idempotency orchestration
 *
 * Shared by add_nodes / create_edges. Two concerns:
 *   • returnMode — an 84-item batch's full diff is ~200 KB, which forces callers
 *     to save-and-grep just to read the token + minted ids. "summary" (the
 *     default) replaces `diff` with a small `counts` object; "full" keeps the
 *     diff alongside it.
 *   • idempotency — a retried confirm carrying the same `idempotencyKey` replays
 *     the first apply's summary instead of erroring with REPLAY (see idempotency.ts).
 *
 * Storage/audit are untouched — this is purely response-shape + a retry cache.
 */
import {
  runGraphMutation, type GraphMutation, type GraphDiff, type MutationGraph,
  type GraphPreviewResult, type GraphBlockedResult, type GraphApplyResult, type GraphUnauthorizedResult,
} from "../kg-store/index.js";
import { lookupIdempotent, recordIdempotent, type IdempotencySummary } from "./idempotency.js";
import { parkWrapperContext, readWrapperContext } from "./wrapper-park.js";

export type ReturnMode = "summary" | "full";

// The add_nodes minted-id fields, threaded onto every shaped result (preview +
// apply) so the caller can wire cross-references. Empty for create_edges.
export type BatchExtra = { mintedNodeIds?: string[]; mintedNodeIdMap?: Record<string, string> };

type MutationResult = GraphPreviewResult | GraphBlockedResult | GraphApplyResult | GraphUnauthorizedResult;

// The compact stand-in for the full diff. Named per the spec's five fields.
export type BatchCounts = {
  nodesAdded: number;
  edgesAdded: number;
  nodesChanged: number;
  nodesRemoved: number;
  edgesRemoved: number;
};

// Exported so the draft-lifecycle tools (publish_draft / discard_draft) shape
// their whole-draft summary with the identical five-field contract — no drift.
export const countsOf = (diff: GraphDiff): BatchCounts => ({
  nodesAdded: diff.nodes.added.length,
  edgesAdded: diff.edges.added.length,
  nodesChanged: diff.nodes.changed.length,
  nodesRemoved: diff.nodes.removed.length,
  edgesRemoved: diff.edges.removed.length,
});

// Turn a framework result into the tool response. Both diff-carrying phases
// (preview, successful apply) get `counts`; only returnMode:"full" also keeps the
// raw `diff`. Non-diff phases (blocked / unauthorized / failed apply) pass through.
// `payloadStored` (preview only) tags a dry-run whose args/extras were parked
// server-side, so the caller knows a token-only confirm is safe.
function shapeResult(result: MutationResult, returnMode: ReturnMode, extra: BatchExtra, payloadStored = false): Record<string, unknown> {
  if (result.phase === "preview") {
    const shaped: Record<string, unknown> = {
      phase: "preview",
      kind: "graphMutation",
      needsConfirmation: true,
      action: result.action,
      // A parked context replaces the framework's re-send message with the
      // token-only phrasing, so the model doesn't regenerate the payload.
      message: payloadStored
        ? result.message.replace(/call this tool again with .*$/, "call this tool again with ONLY confirm:true AND the confirmationToken — the payload is held server-side, do NOT re-send it.")
        : result.message,
      confirmationToken: result.confirmationToken,
      expiresAt: result.expiresAt,
      counts: countsOf(result.diff),
      warnings: result.warnings,
      payloadStored,
      ...extra,
    };
    if (returnMode === "full") {
      shaped.diff = result.diff;
    }
    return shaped;
  }

  if (result.phase === "apply" && result.ok) {
    const shaped: Record<string, unknown> = {
      phase: "apply",
      kind: "graphMutation",
      ok: true,
      applied: result.applied,
      draftSlot: result.draftSlot,
      auditId: result.auditId,
      counts: countsOf(result.diff),
      warnings: [],
      ...extra,
    };
    if (returnMode === "full") {
      shaped.diff = result.diff;
    }
    return shaped;
  }

  // blocked / unauthorized / failed apply — no diff to summarize; return as-is
  // (these are already small, and callers branch on phase/code either way).
  return { ...result };
}

export type RunBatchArgs<Args> = {
  namespace: string;
  mutation: GraphMutation<Args>;
  args: Args;
  confirm?: boolean;
  token?: string;
  returnMode: ReturnMode;
  idempotencyKey?: string;
  payloadHash: string;   // stable hash of the tool request (excl. returnMode)
  extra: BatchExtra;
  // Opt into wrapper-layer parking: on dry-run the BUILT args + extras + payload
  // hash are stashed against the token so a token-only confirm reconstructs them.
  // Only take-effect when the payload is large enough; small batches keep re-send.
  storePayload?: boolean;
};

// The wrapper's parked context for a batch — everything a stored confirm needs
// to reconstruct the response without the caller re-sending anything. Stored
// verbatim (JSON-serialisable) under the token's nonce sibling key.
type ParkedBatchContext<Args> = { args: Args; extra: BatchExtra; payloadHash: string };

// Run a batched mutation with returnMode shaping and optional idempotency.
// Idempotency governs the CONFIRM phase only: a matching retry replays the stored
// summary; a same-key-different-payload retry is a mismatch; a miss applies and
// records. Without a key, behaviour is unchanged (a token replay -> REPLAY).
// Token-only confirm (opts.storePayload): a large dry-run parks {args,extra,
// payloadHash} against the token; the confirm reads them back so the caller
// need not re-send. Small payloads keep the re-send path.
export async function runBatchMutation<Args>(opts: RunBatchArgs<Args>): Promise<Record<string, unknown>> {
  const { namespace, mutation, confirm, token, returnMode, idempotencyKey, storePayload } = opts;

  // On confirm, prefer the PARKED context if one exists — its args are the exact
  // ones the framework's args-hash was minted from, and its extras carry the
  // minted-id echoes the caller would otherwise have to send back. Absent →
  // re-send path (opts.args/extra/payloadHash as passed by the caller).
  let effectiveArgs = opts.args;
  let effectiveExtra = opts.extra;
  let effectivePayloadHash = opts.payloadHash;
  if (confirm && token) {
    const parked = await readWrapperContext<ParkedBatchContext<Args>>(namespace, token);
    if (parked) {
      effectiveArgs = parked.args;
      effectiveExtra = parked.extra;
      effectivePayloadHash = parked.payloadHash;
    }
  }

  if (confirm && idempotencyKey) {
    const found = lookupIdempotent(namespace, idempotencyKey, effectivePayloadHash);
    if (found.status === "replay") {
      // The stored summary IS the original success (minted ids included); mark it
      // replayed. No diff was stored, so a full-mode replay still returns summary.
      return { ...found.summary, replayed: true };
    }
    if (found.status === "mismatch") {
      return {
        phase: "apply",
        kind: "graphMutation",
        ok: false,
        code: "IDEMPOTENCY_KEY_MISMATCH",
        message: `idempotencyKey '${idempotencyKey}' was already used for a DIFFERENT payload in this namespace; nothing was applied. The original applied summary is attached — use a fresh key for a new mutation.`,
        original: found.summary,
      };
    }
    // miss → apply below and record on success.
  }

  const result = await runGraphMutation({ namespace, mutation, args: effectiveArgs, confirm, token });

  // Dry-run park: keep the built context for a possible token-only confirm. The
  // helper decides whether to actually park based on payload size — small ones
  // stay on the cheap re-send path with no store write.
  let parkedNow = false;
  if (!confirm && storePayload && result.phase === "preview") {
    parkedNow = await parkWrapperContext<ParkedBatchContext<Args>>(namespace, result.confirmationToken, {
      args: effectiveArgs, extra: effectiveExtra, payloadHash: effectivePayloadHash,
    });
  }

  const shaped = shapeResult(result, returnMode, effectiveExtra, parkedNow);

  if (confirm && idempotencyKey && result.phase === "apply" && result.ok) {
    // Store the SUMMARY shape (never the diff) so a replay stays small.
    const summary = shapeResult(result, "summary", effectiveExtra) as IdempotencySummary;
    recordIdempotent(namespace, idempotencyKey, effectivePayloadHash, summary);
  }

  // The parked wrapper context is NOT deleted after a successful apply — it must
  // outlive the first confirm so an idempotency-key retry can still read its
  // payloadHash and hit the recorded replay. The framework's nonce ledger blocks
  // any real double-apply; the wrapper entry is TTL-swept later.

  return shaped;
}
