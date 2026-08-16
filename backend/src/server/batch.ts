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
function shapeResult(result: MutationResult, returnMode: ReturnMode, extra: BatchExtra): Record<string, unknown> {
  if (result.phase === "preview") {
    const shaped: Record<string, unknown> = {
      phase: "preview",
      kind: "graphMutation",
      needsConfirmation: true,
      action: result.action,
      message: result.message,
      confirmationToken: result.confirmationToken,
      expiresAt: result.expiresAt,
      counts: countsOf(result.diff),
      warnings: result.warnings,
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
};

// Run a batched mutation with returnMode shaping and optional idempotency.
// Idempotency governs the CONFIRM phase only: a matching retry replays the stored
// summary; a same-key-different-payload retry is a mismatch; a miss applies and
// records. Without a key, behaviour is unchanged (a token replay -> REPLAY).
export async function runBatchMutation<Args>(opts: RunBatchArgs<Args>): Promise<Record<string, unknown>> {
  const { namespace, mutation, args, confirm, token, returnMode, idempotencyKey, payloadHash, extra } = opts;

  if (confirm && idempotencyKey) {
    const found = lookupIdempotent(namespace, idempotencyKey, payloadHash);
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

  const result = await runGraphMutation({ namespace, mutation, args, confirm, token });
  const shaped = shapeResult(result, returnMode, extra);

  if (confirm && idempotencyKey && result.phase === "apply" && result.ok) {
    // Store the SUMMARY shape (never the diff) so a replay stays small.
    const summary = shapeResult(result, "summary", extra) as IdempotencySummary;
    recordIdempotent(namespace, idempotencyKey, payloadHash, summary);
  }

  return shaped;
}
