/*
 * Module: server · idempotency cache for batched mutations
 *
 * Makes a RETRIED confirm a safe no-op instead of a REPLAY error. When a caller
 * passes an `idempotencyKey`, a successful `add_nodes` / `create_edges` apply is
 * recorded here; a later confirm with the same key returns the first apply's
 * summary (marked `replayed`) without re-applying or re-auditing. Reusing a key
 * with a DIFFERENT payload is a caller bug → surfaced as a mismatch.
 *
 * Why here and not in kg-store's framework idempotency: the stored summary is
 * tool-layer data (minted-node ids, the summary shape, the apply's audit id) the
 * subject-agnostic framework never sees. Keys are scoped to a namespace and
 * expire after a TTL. Process-scoped (Cloud Run runs capped instances); a restart
 * clears it, after which the base-hash CAS in runGraphMutation still prevents any
 * double-apply (a landed edit moved the base → a retried confirm gets STALE_TOKEN).
 */
import { createHash } from "node:crypto";

// The summary a successful batch apply stored — returned verbatim on a replay
// (and attached to a mismatch so the caller sees what the key already applied).
export type IdempotencySummary = Record<string, unknown>;

type Entry = {
  payloadHash: string;
  appliedAt: number;          // epoch ms, for TTL eviction
  summary: IdempotencySummary;
};

// 24h: long enough to cover any realistic retry window, short enough that a
// stale key eventually frees up for reuse.
const TTL_MS = 24 * 60 * 60 * 1000;

// Injectable clock so a test can fast-forward past the TTL. Runtime uses Date.now.
let now: () => number = () => Date.now();

const store = new Map<string, Entry>();

const cacheKey = (namespace: string, key: string): string => `${namespace}::${key}`;

// A stable hash of the tool-facing request (its items/edges — NOT returnMode,
// which must not change a request's identity). Two confirms with the same key
// but different payloads then differ here and surface as a mismatch.
export const idempotencyPayloadHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type IdempotencyLookup =
  | { status: "miss" }
  | { status: "replay"; summary: IdempotencySummary }
  | { status: "mismatch"; summary: IdempotencySummary };

// Look up a key. An expired entry is evicted and reported as a miss (so the
// mutation runs fresh). A live entry replays on a matching payload, or reports a
// mismatch (with the ORIGINAL summary) on a different one.
export function lookupIdempotent(namespace: string, key: string, payloadHash: string): IdempotencyLookup {
  const entry = store.get(cacheKey(namespace, key));
  if (!entry) {
    return { status: "miss" };
  }
  if (now() - entry.appliedAt > TTL_MS) {
    store.delete(cacheKey(namespace, key));
    return { status: "miss" };
  }
  if (entry.payloadHash !== payloadHash) {
    return { status: "mismatch", summary: entry.summary };
  }
  return { status: "replay", summary: entry.summary };
}

// Record a successful apply under its key. Called only after the apply committed,
// so a replay always reflects a real, audited change.
export function recordIdempotent(namespace: string, key: string, payloadHash: string, summary: IdempotencySummary): void {
  store.set(cacheKey(namespace, key), { payloadHash, appliedAt: now(), summary });
}

// ── Test seams ────────────────────────────────────────────────────────────────
export const __resetIdempotencyForTest = (): void => {
  store.clear();
  now = () => Date.now();
};
// Advance/override the clock so a test can cross the TTL boundary deterministically.
export const __setIdempotencyNowForTest = (fn: () => number): void => { now = fn; };
