/*
 * Module: server · wrapper-layer park for two-phase tools
 *
 * The framework's own storePayload (mutations.ts) parks the mutation ARGS under
 * the token's nonce, and works for tools whose args flow straight through. Some
 * tools do MORE around the framework: add_nodes mints per-item ids on dry-run
 * and echoes them on confirm; the catalog tools clone a subtree at dry-run and
 * return a mintedIdMap. That extra "wrapper context" (the BUILT args + the
 * response extras + the idempotency-key payload hash) has to survive dry-run →
 * confirm too, or a token-only confirm cannot reconstruct the response.
 *
 * This helper is that survival mechanism. It parks a small JSON-serializable
 * blob against the SAME token, under a distinct sibling key (`${nonce}:w`), so
 * framework-parked args and wrapper-parked context never collide. Everything
 * else stays the framework's job: exactly-once + staleness are still the nonce
 * ledger + base-hash CAS on the framework side. A vanished wrapper entry is
 * treated as absent — the caller falls back to the re-send path (which will
 * itself STALE cleanly if the caller has no payload to send).
 */

import { getKgStore } from "../kg-store/index.js";
import { readTokenNonce, shouldStorePayload, pendingTtlMs } from "../kg-store/index.js";

// The suffix keeps the wrapper's parked doc distinct from the framework's own
// parked args (which live under the bare nonce). Both stores' methods take the
// nonce as an opaque string, so a "namespace/nonce/suffix" scheme just works.
const wrapperKey = (nonce: string): string => `${nonce}:w`;

// Park a wrapper's context iff `payload` is big enough to be worth NOT re-sending
// (same threshold as the framework's storePayload — one knob controls both).
// Returns whether it parked, so the caller can tag `payloadStored` on its response.
export async function parkWrapperContext<T>(namespace: string, token: string, payload: T): Promise<boolean> {
  if (!shouldStorePayload(payload)) return false;
  const nonce = readTokenNonce(token);
  if (!nonce) return false;  // malformed token — the framework will reject the confirm
  await getKgStore().putPending(namespace, wrapperKey(nonce), {
    op: "wrapperContext",
    // proposedHash is unused by wrapper-park (the caller isn't re-sending anything
    // to hash-check against); we fill it with a stable placeholder so the record
    // shape matches PendingEntry's schema.
    proposedHash: "",
    payload,
    expiresAt: Date.now() + pendingTtlMs(),
  });
  return true;
}

// Read back a wrapper's parked context for a confirm, or null if nothing was
// parked (small-payload path) or the entry has vanished (TTL / restart / already
// consumed). A null return means the caller should fall back to its re-send path.
export async function readWrapperContext<T>(namespace: string, token: string): Promise<T | null> {
  const nonce = readTokenNonce(token);
  if (!nonce) return null;
  const entry = await getKgStore().readPending(namespace, wrapperKey(nonce));
  return entry ? (entry.payload as T) : null;
}

// Best-effort cleanup after a successful confirm — the framework's nonce ledger
// already blocks a replay, so a failed delete only leaves a TTL-swept orphan.
export async function deleteWrapperContext(namespace: string, token: string): Promise<void> {
  const nonce = readTokenNonce(token);
  if (!nonce) return;
  try { await getKgStore().deletePending(namespace, wrapperKey(nonce)); } catch { /* TTL sweeps it */ }
}
