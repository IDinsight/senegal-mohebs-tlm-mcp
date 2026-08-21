# Canonical + changeset store (a git-like working copy)

> **Status: Live.** This redesign of the KG store's draft/publish lifecycle shipped:
> the a/b **double-buffer** (two full copies of the graph, `createDraft` copies
> published → free slot) was replaced with a **single canonical graph + a small
> changeset overlay** of uncommitted edits — the git mental model (one committed
> tree + a staging area). Motivated by measured production numbers (below):
> `createDraft`'s whole-graph copy was a real **~15s tax on the first edit of every
> editing session**; the overlay cut it to ~1s. This note lays out the model, the one
> genuine tradeoff (publish atomicity for very large sessions — handled by the
> small-publish transaction cap with a scratch-and-swap fallback), and the migration.
> It supersedes the draft-slot copy mechanics described in
> [`firestore-only-store.md`](firestore-only-store.md); the current operational
> summary is [`../technical-reference/store.md`](../technical-reference/store.md).

## Why

Graph mutations were slow (minutes) because every confirm did whole-graph
Firestore I/O. A first round of work — delta writes (`applyDelta`), parallel +
orphan-only `createDraft`, and deduped reads — fixed the per-edit cost (a
follow-up edit dropped from ~55s to a few seconds). What that work **could not**
remove is the whole-graph **copy** `createDraft` still performs the first time a
curator opens a draft: the draft slot must hold a complete graph so that a later
publish (a pointer flip) exposes a complete graph.

Measured on the deployed server (`ce1/reading`, 2009 nodes / 2298 edges,
europe-west1 co-located with Firestore, `TLM_TIMING`):

| Phase | First edit | Follow-up edit |
|---|--:|--:|
| readBase | 2.7s | 3.6s |
| **createDraft (copy ~4,300 docs)** | **14.7s** | — |
| reReadDraft | 2.2s | 2.1s |
| applyFold + diff + hash | 0.9s | 0.9s |
| applyDelta | 1.5s | 1.4s |
| **server-side total** | **~22s** | **~8s** |

The copy is ~4,300 *large* docs (reading's nodes carry heavy `metadata`); even
concurrent 450-doc batches take ~9–11s. So the first edit of a session pays a
~15s copy tax that no amount of parallelising the copy removes — the work itself
is O(graph). The only way to remove it is to stop copying.

## The model

Today a draft is a **physical duplicate** of published in the other slot. The
proposal: a draft is **published + a changeset** (a small overlay of what
changed), exactly like uncommitted changes in git.

- **Canonical graph** — the single published state. One copy. No `a`/`b` slots.
- **Changeset** — the uncommitted edits for a namespace: the full bodies of
  added/changed nodes and edges, plus **tombstones** (ids marked deleted). Small
  — only what this session touched.
- **Read published** = canonical.
- **Read working/draft** = canonical, with the changeset overlaid: a changeset
  doc wins over the canonical doc of the same id; a tombstone hides the canonical
  doc.
- **Edit** = append to the changeset (already the shape `applyDelta` writes).
- **Publish / commit** = apply the changeset onto canonical, then clear it.
- **Discard** = drop the changeset. Canonical untouched.

### Worked example

A curator opens `ce1/reading` and adds 2 lessons, then edits 1 title.

- Today: `createDraft` copies all 4,307 docs into slot `b` (~15s), then two
  `applyDelta`s write 2+1 docs onto slot `b`. Publish flips the pointer.
- Proposed: opening the draft writes **nothing** (an empty changeset marker).
  The two edits write 3 changeset docs. The working graph a reader sees =
  canonical (4,307) with those 3 overlaid. Publish applies **3 doc writes** onto
  canonical and clears the changeset.

`createDraft`'s 15s copy disappears; publish shrinks from an O(1) flip to an
O(3) write.

## Decisions

| # | Decision | Choice |
|---|---|---|
| C1 | Lifecycle model | **Canonical graph + changeset overlay**, replacing the a/b double-buffer. `createDraft` becomes O(1) — write an "open" marker, no copy. |
| C2 | Changeset storage | A per-namespace **overlay partition** (`kg_staged_nodes` / `kg_staged_edges`, or the existing collections tagged `staged:true` + `namespace`). Holds full bodies of added/changed docs + **tombstone** markers for deletes. Sized to the session's edits, not the graph. |
| C3 | Draft reads | **Store-internal merge.** `listNodes(ns, "draft")` / `listEdges(ns, "draft")` transparently return `canonical ∪ overlay − tombstones`. The 7 modules that read draft slots (preview, walk_graph, diff_draft, profile, export, the confirm path) **do not change** — the merge lives behind the existing interface. |
| C4 | Deletes | **Tombstones** in the changeset (the canonical doc still exists; the tombstone masks it in the merge). Cleared on publish/discard. |
| C5 | Publish atomicity | Apply the changeset onto canonical. **Atomic for a changeset under Firestore's ~500-write transaction cap** (one transaction — covers typical sessions). Larger sessions need a documented strategy — see **Open question O1**; this is the one genuine tradeoff vs the always-atomic pointer flip. |
| C6 | Discard | Delete the changeset partition. O(changeset), off the interactive path. |
| C7 | Base-version CAS | Unchanged in spirit: the confirm token still hashes the working graph (`canonical` merged with `overlay`) so a concurrent edit still invalidates a stale token. |
| C8 | Config + meta cells | The subject-profile `config` and `meta` stamps ride the slot pointer today (per-slot `configA`/`configB`, `metaA`/`metaB`). They gain a **staged overlay** too (a staged config / staged meta), published and discarded with the changeset — mirroring how `edit_profile` already stages onto the draft slot. |
| C9 | `diff_draft` | Becomes **trivial**: the changeset *is* the diff. No more `diffGraphs` serialising the whole graph twice to discover what changed. |
| C10 | Migration | One-time, per namespace: the current published slot becomes canonical; the draft slot (if any) becomes a changeset (or is dropped). `import-kg` / `export-kg` updated to the canonical shape. Both live Senegal namespaces + Nigeria migrated once. See **Migration** below. |
| C11 | Firestore indexes | The reads are equality-only (`namespace ==`, and a `staged` flag). Firestore serves these from **single-field indexes** (auto-created) — no composite index is required, and none is the lever for the measured read cost (that is document-transfer bound, not index bound). A composite `(namespace, staged)` index is an optional micro-optimisation, not a dependency. See **Indexes**. |

## What changes, what doesn't

**Contained to the store** (the win): `createDraft` / `publishDraft` /
`discardDraft` / `applyDelta` in `firestore.ts` + `memory.ts`, the pointer/schema
shape, and the doc-id scheme (`ns::slot::id` → `ns::id` for canonical + a staged
key space). Because the merge sits behind `listNodes`/`listEdges` (C3), the
**callers stay put**.

**Explicitly preserved**: the two-phase confirm framework (dry-run → token →
confirm), the base-version hash-CAS, the append-only audit, per-workspace authz,
and the "published is never seen partial" guarantee for normal-sized publishes.

## Publish atomicity — the one real tradeoff

The double-buffer's crown jewel is **publish is atomic no matter what** (a
single-doc pointer flip). The canonical model applies the changeset onto
canonical in place:

- **Typical session** (a few to a few dozen changes) → under the ~500-write
  transaction cap → **one atomic transaction → fully atomic.** No reader sees a
  partial graph.
- **Very large session** (>500 changed docs — e.g. a bulk authoring pass) →
  can't be one transaction. Options in **O1**.

Worth noting: today only *publish* is atomic; the bulk draft writes already
aren't (see `firestore.ts` — only the final meta+audit touch is transactional).
So the canonical model preserves the guarantee that actually matters — *published
never observed partial* — for the common case, and needs an explicit decision
only for the large-session tail.

## Migration

Each namespace, once (an operator script, same footing as `import-kg`):

1. Read the current published slot → write it as the **canonical** graph
   (drop the `slot` tag; re-key docs `ns::id`).
2. If a draft slot is open, either convert its diff-vs-published into a
   **changeset**, or (simpler, and what the double-buffer already tolerates on
   discard) drop it and ask the curator to re-stage.
3. Move the published `config`/`meta` cells to their canonical home; clear the
   per-slot cells.
4. Delete the old a/b slot docs.

`import-kg` writes canonical directly; `export-kg` reads canonical. Both live
Senegal namespaces (`ci/maths`, `ce1/reading`) and `nigeria/primary-1-3/maths`
migrate once, with the same reseed-then-verify rollout the `rollout`
skill already covers.

## Open questions

- **O1 — large-session publish.** For a changeset over the transaction cap:
  (a) **chunked apply** with a brief non-atomic window (acceptable? publish is a
  deliberate, infrequent curator action, and generation reads published — a
  reader mid-publish could momentarily see a half-applied graph);
  (b) **scratch-and-swap** — materialise `canonical ∪ changeset` into a scratch
  copy, then an atomic pointer swap (reintroduces an O(graph) write, but only for
  the rare huge publish, and keeps atomicity);
  (c) **versioned reads (MVCC)** — a published-version counter readers pin to;
  most robust, most complex. **Recommendation: (a) with a documented bound now,
  design (b) as the escape hatch if a real large-publish appears.**
- **O2 — merge cost on hot draft reads.** A draft read is `canonical (~2–3s co-located)` + overlay (small) + an in-memory merge. That's ~the same as today's materialised-draft read, so no regression — but confirm on the largest graph before committing.
- **O3 — orphaned canonical after publish.** Publishing in place mutates canonical directly; there's no "old slot" to fall back to. Keep the append-only audit + `export-kg` backups as the recovery story, or add a short-lived pre-publish snapshot.

## Alternatives considered

- **Keep the double-buffer, "clean vacated slots."** Make discard/publish empty
  the slot they leave, so `createDraft` skips its dest-read. Removes ~2s, **not**
  the ~15s copy. Cheap and safe, but doesn't solve the actual cost. Not worth it
  on its own.
- **Interim read-dedup (ship-now, independent of this note).** On the `onDraft`
  path, `readBase` and `reReadDraft` both read the full draft (~2–3s each,
  co-located). Reusing the first read trims ~2–3s off **every** edit. Small,
  contained; needs a note on the concurrency window (the re-read currently
  shrinks it). A good pick regardless of whether Phase 3 proceeds.
- **Do nothing.** The first-edit ~15s is **once per session** (opening a draft),
  not per edit; follow-up edits are ~8s and reads-bound. A "preparing draft…"
  indicator masks the one-time cost far more cheaply than this rewrite. This is
  the honest baseline the rewrite must beat: it buys ~15s off the first edit of a
  session and a cleaner model (O(1) draft, trivial diff, half the storage), at
  the cost of a core store rewrite + live migration + the O1 tradeoff.

## Recommendation

The measured ~15s copy justifies **taking this seriously**, but the payoff (~15s
off the *first* edit of a session; modest gains on follow-ups, which are
reads-bound) is bounded, and the change is invasive. Suggested sequence:

1. **Ship the interim read-dedup** now — small, safe, helps every edit.
2. **Decide O1** (large-session publish) — it's the gating design question.
3. If O1 lands cleanly, **build the canonical model behind the store interface**
   (C3 keeps the blast radius in `firestore.ts`/`memory.ts`), migrate one
   namespace, verify, then roll out.

If the one-time ~15s proves tolerable in practice (with a UI indicator), the
cleaner model — not the speed — becomes the main reason to do it, and that's a
fair thing to defer.
