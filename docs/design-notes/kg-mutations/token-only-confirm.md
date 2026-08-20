# Token-only confirm — parking large payloads instead of re-sending

> **Status: Live (framework substrate + `edit_profile` + `edit_node`).** The
> pending-payload store and the size-triggered stored/re-send split are shipped
> and tested. `edit_profile` and `edit_node` opt in; the batch/minting tools
> (`add_nodes`, `create_edges`, `use_routine`/`use_formatter`/`add_to_catalog`)
> deliberately stay on re-send for now — see **Deferred** below.

## The problem

Every two-phase write re-sends its full payload on confirm. The confirmation
token holds only a **hash** of the args (`a` in
[`mutations.ts`](../../../backend/src/kg-store/mutations.ts), `pv` in
[`config-flow.ts`](../../../backend/src/kg-store/config-flow.ts)), never the
payload — so the server keeps no pending state and the confirm must carry the
args again, where they are re-hashed and checked against the token.

In an **LLM-driven** server "re-send" means the model regenerates the entire
payload as output tokens. For a big, prose-heavy payload — a whole `{ core, guide }`
profile record, a full `content` rewrite — that costs output tokens and,
worse, is **fidelity-fragile**: a single reworded sentence changes the hash →
`ARGS_MISMATCH` → forced re-preview. The pain is concentrated in exactly the
tools with large payloads; tiny structural edits (`move_node`, a title tweak)
re-send for free.

## The mechanism

At **dry-run**, when a caller opts in *and* the serialized args cross a size
threshold (`TLM_CONFIRM_STORE_BYTES`, default 4 KB), the payload is **parked**
server-side under the token's one-time nonce (`putPending`); the token is
stamped `mode: "stored"`. At **confirm**, a stored token's args are read back
by nonce (`readPending`) instead of the caller re-sending them; the entry is
deleted best-effort after a successful apply. Below the threshold, or without
opt-in, nothing is parked and the token stays `mode: "resend"` — today's exact
path.

The parked entry is [`PendingEntry`](../../../backend/src/kg-store/types.ts):
`{ op, proposedHash, payload, expiresAt }`, keyed by `(namespace, nonce)`.

### Where it lives, and why Firestore

Parked payloads are **pure payload storage**, not a lock. The store gained three
methods — `putPending` / `readPending` / `deletePending` — implemented on both
backends (in-memory for tests, Firestore for prod, collection `kg_pending`).
Firestore, not Redis or an in-memory map, because:

- It is already the coordination substrate (pointer, audit, config cell), so no
  new dependency or failure domain.
- It survives an instance restart between dry-run and confirm — which the
  **current** stateless token also does, so an in-memory map would have *removed*
  an existing resilience property.
- `expiresAt` supports a Firestore TTL policy to reclaim abandoned previews;
  `readPending` also enforces expiry itself, so correctness never depends on the
  policy being configured.

### Why it is safe

Exactly-once and "nothing moved since dry-run" are **not** provided by the
pending entry. They remain the **nonce ledger** (one-time use) plus the
**base-hash CAS** (the token's `v`/`cv` must still match the slot). So a lost,
expired, or already-consumed entry can only ever force a fresh dry-run — never a
double-apply. Two ordering consequences fell out of this and are load-bearing:

1. The **replay guard runs before** `readPending`. A replayed stored token whose
   parked entry was already deleted must report the replay, not a misleading
   "payload missing" stale.
2. `edit_profile` keeps a **defensive match check**: if a caller *does* re-send a
   record in stored mode, it must still hash to the token's `pv` — a differing
   re-send is `ARGS_MISMATCH`, never a silent apply of the previewed record. (The
   graph path can't do this — a token-only `edit_node` confirm legitimately
   carries only a partial arg shape, e.g. `nodeId` without `content` — so it
   ignores the re-sent args and trusts the parked payload + nonce + CAS.)

The dry-run response carries `payloadStored: true|false` and a tailored
`message`, so the model knows whether it may confirm with the token alone.

## Scope: opt-in, size-triggered, not a per-tool allowlist

The switch is `storePayload` on `runGraphMutation` (and always-on inside
`editProfileWithConfirm`), gated by the shared size threshold. Only a caller that
passes its **complete** args straight through — no wrapper that rebuilds args or
mints ids per phase — may opt in. Today:

- **`edit_profile`** — parks the `{ core, guide }` record; confirm needs only the
  token. `profile` is now optional on the tool.
- **`edit_node`** — parks a large `content` edit; confirm needs only `nodeId` +
  the token (content is the big field).

### Deferred: the batch/minting tools

`add_nodes` / `create_edges` and the catalog `use_*` / `add_to_catalog` tools run
through a wrapper (`runBatchMutation`, `runAddNodes`) that **rebuilds args and
mints/echoes ids on both phases**. Token-only confirm there needs the *built*
args and the returned minted ids to be parked at that wrapper layer, not just
inside `runGraphMutation`, and the returned `mintedNodeIds` reconstructed on a
payload-less confirm. That is a separate, larger change; these tools stay on the
re-send path until it lands. The framework substrate is already in place for
them — flipping each on is "park the built args at the wrapper + relax the schema
+ reconstruct the minted-id echo."
