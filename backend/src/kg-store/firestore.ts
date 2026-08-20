/*
 * Module: kg-store · internal
 *
 * Firestore-backed KgNodeStore. Three top-level collections:
 *   kg_nodes    — {namespace, slot, id, type, properties, …}
 *   kg_edges    — {namespace, slot, id, type, from, to, properties, …}
 *   kg_pointers — one doc per namespace: {publishedSlot, draftSlot|null}
 *                 the atomic swap point for the draft/published lifecycle.
 * A per-namespace meta stamp lives on the pointer doc (one field per slot),
 * so it participates in the same transactional writes as the pointer itself.
 *
 * Doc ids are `${nsSlug}::${slot}::${id}` so slot A and slot B can hold two
 * copies of the same node id side by side without collision.
 *
 * Firebase Admin is initialised the same way `storage/firebase.ts` does it
 * (key file, key JSON, or ADC). The SDK dedupes app initialisation, so both
 * modules can call it independently without stepping on each other.
 */
import { createRequire } from "node:module";
import { CONFIG } from "../config.js";
import type { AuditQuery, AuditRecord, KgNodeStore, PendingEntry, Slot, SlotDelta, StoredConfig, StoredEdge, StoredMeta, StoredNode, StoredPointer } from "./types.js";
import { otherSlot } from "./types.js";
import { matchesAuditQuery, sortAuditNewestFirst } from "./audit.js";
import { timed, note } from "../utils/index.js";

const require = createRequire(import.meta.url);

// Minimal Firestore type surface. Kept structural to avoid a hard dependency on
// firebase-admin's exported types at compile time.
interface FsDoc {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
  ref: FsDocRef;
}
type FsSetOpts = { merge?: boolean };
interface FsDocRef {
  set(data: Record<string, unknown>, opts?: FsSetOpts): Promise<unknown>;
  delete(): Promise<unknown>;
}
interface FsQuerySnap { docs: FsDoc[] }
interface FsQuery { get(): Promise<FsQuerySnap> }
interface FsCollection extends FsQuery {
  doc(id: string): FsDocRef & { get(): Promise<FsDoc> };
  where(field: string, op: string, value: unknown): FsQuery & { where(field: string, op: string, value: unknown): FsQuery };
}
interface FsBatch { set(ref: FsDocRef, data: Record<string, unknown>): FsBatch; delete(ref: FsDocRef): FsBatch; commit(): Promise<unknown> }
interface FsTransaction {
  get(ref: FsDocRef): Promise<FsDoc>;
  get(query: FsQuery): Promise<FsQuerySnap>;
  set(ref: FsDocRef, data: Record<string, unknown>, opts?: FsSetOpts): FsTransaction;
  update(ref: FsDocRef, data: Record<string, unknown>): FsTransaction;
  delete(ref: FsDocRef): FsTransaction;
}
interface Firestore {
  collection(name: string): FsCollection;
  batch(): FsBatch;
  runTransaction<T>(fn: (tx: FsTransaction) => Promise<T>): Promise<T>;
}

const fbApp = require("firebase-admin/app") as {
  initializeApp: (opts: { credential: unknown; storageBucket?: string }) => unknown;
  cert: (serviceAccountPathOrObject: string | object) => unknown;
  applicationDefault: () => unknown;
  getApps: () => unknown[];
};
const fbFirestore = require("firebase-admin/firestore") as { getFirestore: () => Firestore };

function initFirebase(): void {
  if (fbApp.getApps().length > 0) return;
  const credential = CONFIG.serviceAccountKeyPath
    ? fbApp.cert(CONFIG.serviceAccountKeyPath)
    : CONFIG.serviceAccountKeyJson
      ? fbApp.cert(JSON.parse(CONFIG.serviceAccountKeyJson))
      : fbApp.applicationDefault();
  fbApp.initializeApp({ credential, storageBucket: CONFIG.firebaseBucket || undefined });
}

// Firestore doc ids cannot contain "/", so the namespace ("<prefix>ci/maths")
// is flattened. Pointer docs use the flat form directly as their id.
const nsSlug = (ns: string) => ns.replace(/\//g, "__");
const docId = (ns: string, slot: Slot, id: string) => `${nsSlug(ns)}::${slot}::${id}`;
const NODES = "kg_nodes";
const EDGES = "kg_edges";
const POINTERS = "kg_pointers";
// Append-only audit collection. Every state-changing graph op writes a doc
// here in the SAME transaction as its state write; blocked-attempt records
// are plain `create` writes (no state to join). No code path calls update()
// or delete() on these docs — see appendAudit / listAudit below. A future
// Firestore security rule can lock this in externally; for now the barrier
// is the write-only surface exposed by KgNodeStore.
const AUDIT = "kg_audit";
// Parked confirm payloads (see PendingEntry). One doc per nonce, id
// `${nsSlug}::${nonce}`. Short-lived: written at dry-run, deleted after a
// successful confirm, and lazily ignored past `expiresAt`. Configure a Firestore
// TTL policy on the `expiresAt` field to reclaim abandoned previews' storage;
// correctness does not depend on it (reads enforce expiry themselves).
const PENDING = "kg_pending";
// Firestore caps a WriteBatch at 500 operations. We stay a bit under to leave
// headroom.
const BATCH_MAX = 450;
// Cap on batch commits in flight at once. The batches within one commitInChunks
// call target disjoint doc ids, so they're safe to commit concurrently; the cap
// just keeps us from opening an unbounded number of gRPC streams on a very large
// graph. High enough that a ~2,300-edge graph's ~6 batches all run in parallel.
const MAX_CONCURRENT_COMMITS = 12;

// Run `task` over each item with at most `limit` in flight — a small bounded
// worker pool. Rejects on the first failure (Promise.all semantics per wave).
async function runPooled<T>(items: T[], limit: number, task: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const mine = items[next++];
      await task(mine);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// `label` names which slice of writes this call carried (node-upserts,
// edge-copies, …) so a TLM_TIMING trace shows where the write time goes. The
// per-call chunk commits run CONCURRENTLY (bounded by MAX_CONCURRENT_COMMITS) —
// they touch disjoint doc ids, so there's no ordering constraint between them.
async function commitInChunks<T>(db: Firestore, items: T[], apply: (batch: FsBatch, item: T) => void, label = "commit"): Promise<void> {
  if (items.length === 0) return;
  const batches: FsBatch[] = [];
  for (let i = 0; i < items.length; i += BATCH_MAX) {
    const b = db.batch();
    for (const item of items.slice(i, i + BATCH_MAX)) apply(b, item);
    batches.push(b);
  }
  await timed(`firestore.${label}`, () => runPooled(batches, MAX_CONCURRENT_COMMITS, (b) => b.commit()));
  note(`firestore.${label}`, `${items.length} ops in ${batches.length} concurrent batch(es)`);
}

// ── Canonical + changeset overlay ────────────────────────────────────────────
// A DRAFT slot stores only an OVERLAY: the docs an editing session changed, plus
// tombstone markers for the ids it deleted — NOT a full copy (see
// docs/design-notes/canonical-changeset-store.md). A tombstone is a doc carrying
// just {id, namespace, slot, _tombstone:true}; it masks the canonical doc of the
// same id in a draft read and becomes a canonical delete at publish.
const TOMBSTONE = "_tombstone";

// Max WRITES a small publish applies in one transaction. Firestore caps a
// transaction at 500 writes; a publish writes ~2 per overlay doc (apply to
// canonical + clear the overlay doc) plus the pointer + audit, so we cap the
// overlay at ~240 and take the scratch-and-swap path above that. Interactive
// sessions are far smaller; only a bulk pass crosses this.
const PUBLISH_TXN_MAX = 240;

// Merge a canonical layer with a draft overlay: overlay upserts win by id,
// tombstones remove. `overlay` is the raw draft-slot docs (some are tombstones).
function mergeOverlay<T extends { id: string }>(canonical: T[], overlay: Array<Record<string, unknown>>): T[] {
  const merged = new Map(canonical.map((x) => [x.id, x]));
  for (const d of overlay) {
    const id = d.id as string;
    if (d[TOMBSTONE]) merged.delete(id);
    else merged.set(id, d as unknown as T);
  }
  return [...merged.values()];
}

// Pointer doc layout. We keep the two per-slot meta stamps AND the two per-slot
// profile-config cells on the same doc as the pointer, so a publish (which is
// transactional on the pointer) swaps both the "current" meta and the "current"
// profile atomically with the slot flip — no separate publish step for config.
type PointerDoc = {
  publishedSlot: Slot;
  draftSlot: Slot | null;
  metaA?: StoredMeta | null;
  metaB?: StoredMeta | null;
  configA?: StoredConfig | null;
  configB?: StoredConfig | null;
};
const metaField = (slot: Slot): "metaA" | "metaB" => (slot === "a" ? "metaA" : "metaB");
const configField = (slot: Slot): "configA" | "configB" => (slot === "a" ? "configA" : "configB");

export function createFirestoreKgStore(): KgNodeStore {
  initFirebase();
  const db = fbFirestore.getFirestore();

  const pointerRef = (ns: string) => db.collection(POINTERS).doc(nsSlug(ns));

  async function fetchPointer(ns: string): Promise<PointerDoc | null> {
    const doc = await pointerRef(ns).get();
    return doc.exists ? ((doc.data() as PointerDoc) ?? null) : null;
  }

  return {
    kind: "firestore",

    // A published/seed slot read returns the slot's docs directly. A DRAFT slot
    // read merges the canonical (published) graph with the draft's overlay —
    // callers still see a complete graph (the interface hides the split). The
    // pointer fetch runs in parallel with the slot query, so a plain published
    // read is still one round trip.
    async listNodes(namespace, slot) {
      const [p, direct] = await Promise.all([
        fetchPointer(namespace),
        db.collection(NODES).where("namespace", "==", namespace).where("slot", "==", slot).get(),
      ]);
      const directData = direct.docs.map((d) => d.data() as StoredNode & Record<string, unknown>);
      if (p?.draftSlot === slot) {
        const canon = await db.collection(NODES).where("namespace", "==", namespace).where("slot", "==", p.publishedSlot).get();
        return mergeOverlay(canon.docs.map((d) => d.data() as StoredNode), directData);
      }
      return directData.filter((d) => !d[TOMBSTONE]) as StoredNode[];
    },

    async listEdges(namespace, slot) {
      const [p, direct] = await Promise.all([
        fetchPointer(namespace),
        db.collection(EDGES).where("namespace", "==", namespace).where("slot", "==", slot).get(),
      ]);
      const directData = direct.docs.map((d) => d.data() as StoredEdge & Record<string, unknown>);
      if (p?.draftSlot === slot) {
        const canon = await db.collection(EDGES).where("namespace", "==", namespace).where("slot", "==", p.publishedSlot).get();
        return mergeOverlay(canon.docs.map((d) => d.data() as StoredEdge), directData);
      }
      return directData.filter((d) => !d[TOMBSTONE]) as StoredEdge[];
    },

    async readMeta(namespace, slot) {
      const p = await fetchPointer(namespace);
      const stored = p ? p[metaField(slot)] : null;
      return stored ?? null;
    },

    async readConfig(namespace, slot) {
      const p = await fetchPointer(namespace);
      const stored = p ? p[configField(slot)] : null;
      return stored ?? null;
    },

    async readPointer(namespace) {
      const p = await fetchPointer(namespace);
      if (!p) return null;
      return { publishedSlot: p.publishedSlot, draftSlot: p.draftSlot ?? null };
    },

    // One pointer doc per namespace, its id the flattened namespace — reverse
    // the "/"→"__" slug to recover the original key. (nsSlug is lossless: every
    // namespace segment is slug()-ed, so "__" never occurs inside one.)
    async listNamespaces() {
      const snap = await db.collection(POINTERS).get();
      return snap.docs.map((d) => d.id.replace(/__/g, "/"));
    },

    async writeSlot(namespace, slot, batch, audit) {
      // Idempotency (per slot): upsert target ids, delete stragglers in this
      // slot only. The other slot is untouched — critical for createDraft's
      // copy phase not to disturb the published data.
      const [existingNodes, existingEdges] = await timed("writeSlot.readExisting", () => Promise.all([
        db.collection(NODES).where("namespace", "==", namespace).where("slot", "==", slot).get(),
        db.collection(EDGES).where("namespace", "==", namespace).where("slot", "==", slot).get(),
      ]));
      const targetNodeIds = new Set(batch.nodes.map((n) => docId(namespace, slot, n.id)));
      const targetEdgeIds = new Set(batch.edges.map((e) => docId(namespace, slot, e.id)));

      const nodeWrites = batch.nodes.map((n) => ({ ref: db.collection(NODES).doc(docId(namespace, slot, n.id)), data: { ...n, namespace, slot } }));
      const edgeWrites = batch.edges.map((e) => ({ ref: db.collection(EDGES).doc(docId(namespace, slot, e.id)), data: { ...e, namespace, slot } }));
      const nodeDeletes = existingNodes.docs.filter((d) => !targetNodeIds.has(d.id)).map((d) => d.ref);
      const edgeDeletes = existingEdges.docs.filter((d) => !targetEdgeIds.has(d.id)).map((d) => d.ref);

      // writeSlot rewrites the WHOLE slot (seed + createDraft's copy path use
      // it); the edit hot path uses applyDelta instead. The four slices touch
      // disjoint doc ids (upsert targets vs delete-only stragglers), so they run
      // concurrently rather than one-after-another.
      await Promise.all([
        commitInChunks(db, nodeWrites, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); }, "writeSlot.nodeUpserts"),
        commitInChunks(db, edgeWrites, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); }, "writeSlot.edgeUpserts"),
        commitInChunks(db, nodeDeletes, (b, r) => { b.delete(r); }, "writeSlot.nodeDeletes"),
        commitInChunks(db, edgeDeletes, (b, r) => { b.delete(r); }, "writeSlot.edgeDeletes"),
      ]);

      // Final step: stash the slot's meta on the pointer doc AND — when the
      // caller passed an audit — write the audit doc, in the SAME
      // transaction. Firestore's single-doc write guarantee makes the meta
      // touch atomic; adding the audit set to the same tx extends that
      // guarantee to the audit doc. If this tx fails, neither writes and the
      // caller sees the throw. Note: the bulk node/edge writes above are NOT
      // in this transaction (Firestore txns cap at 500 writes) — a crash
      // between them and this final tx leaves an inconsistent slot with no
      // audit, which is the same partial-write window #4 already had.
      await db.runTransaction(async (tx) => {
        const pRef = pointerRef(namespace);
        const doc = await tx.get(pRef as unknown as FsDocRef);
        const prev = (doc.data() as PointerDoc | undefined) ?? {};
        tx.set(pRef as unknown as FsDocRef, { ...prev, [metaField(slot)]: { ...batch.meta } }, { merge: true });
        if (audit) tx.set(db.collection(AUDIT).doc(audit.id) as unknown as FsDocRef, audit as unknown as Record<string, unknown>);
      });
    },

    async applyDelta(namespace, slot, delta, meta, audit) {
      // The edit hot path, writing ONLY what changed onto the draft's OVERLAY:
      // upserts hit the added/changed ids; a removed id is written as a TOMBSTONE
      // (the canonical doc still exists — the tombstone masks it in the draft
      // merge and becomes a canonical delete at publish). No full-slot read or
      // rewrite; correct because runGraphMutation computed the delta against this
      // draft's current (merged) contents (base-version hash-CAS — see types.ts).
      const nodeUpserts = delta.upsertNodes.map((n) => ({ ref: db.collection(NODES).doc(docId(namespace, slot, n.id)), data: { ...n, namespace, slot } }));
      const edgeUpserts = delta.upsertEdges.map((e) => ({ ref: db.collection(EDGES).doc(docId(namespace, slot, e.id)), data: { ...e, namespace, slot } }));
      const nodeTombstones = delta.removeNodeIds.map((id) => ({ ref: db.collection(NODES).doc(docId(namespace, slot, id)), data: { id, namespace, slot, [TOMBSTONE]: true } }));
      const edgeTombstones = delta.removeEdgeIds.map((id) => ({ ref: db.collection(EDGES).doc(docId(namespace, slot, id)), data: { id, namespace, slot, [TOMBSTONE]: true } }));

      await Promise.all([
        commitInChunks(db, nodeUpserts, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); }, "applyDelta.nodeUpserts"),
        commitInChunks(db, edgeUpserts, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); }, "applyDelta.edgeUpserts"),
        commitInChunks(db, nodeTombstones, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); }, "applyDelta.nodeTombstones"),
        commitInChunks(db, edgeTombstones, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); }, "applyDelta.edgeTombstones"),
      ]);

      // Same final meta+audit transaction as writeSlot: the committed edit
      // always carries its record, atomically with the slot's meta stamp.
      await db.runTransaction(async (tx) => {
        const pRef = pointerRef(namespace);
        const doc = await tx.get(pRef as unknown as FsDocRef);
        const prev = (doc.data() as PointerDoc | undefined) ?? {};
        tx.set(pRef as unknown as FsDocRef, { ...prev, [metaField(slot)]: { ...meta } }, { merge: true });
        if (audit) tx.set(db.collection(AUDIT).doc(audit.id) as unknown as FsDocRef, audit as unknown as Record<string, unknown>);
      });
    },

    async writeConfig(namespace, slot, config, audit) {
      // Single-doc transaction on the pointer, mirroring writeSlot's final meta
      // touch: set this slot's config cell and — when the caller passed an audit
      // — the audit doc, together, so a committed profile edit always has its
      // record.
      //
      // We REPLACE the config cell rather than merging it. This must NOT use
      // `merge: true`: Firestore deep-merges nested map fields, so a merged write
      // could only ever ADD keys to the cell — a profile edit that drops a key
      // (e.g. a retired `coverage`/`deliverables`) would leave the stale key
      // behind, producing a hybrid cell that fails validation. Instead we read
      // the whole pointer in-transaction and write it back with only this slot's
      // cell swapped, so the other slot's cell and the pointer fields are
      // preserved while the target cell is fully replaced.
      await db.runTransaction(async (tx) => {
        const pRef = pointerRef(namespace);
        const doc = await tx.get(pRef as unknown as FsDocRef);
        const prev = (doc.data() as PointerDoc | undefined) ?? {};
        tx.set(pRef as unknown as FsDocRef, { ...prev, [configField(slot)]: { ...config } });
        if (audit) tx.set(db.collection(AUDIT).doc(audit.id) as unknown as FsDocRef, audit as unknown as Record<string, unknown>);
      });
    },

    async ensurePointer(namespace, publishedSlot) {
      // Transactional so two concurrent seeds don't race the initial pointer
      // creation. If it already exists, we leave it alone — the seed shouldn't
      // silently move which slot is published.
      await db.runTransaction(async (tx) => {
        const ref = pointerRef(namespace);
        const doc = await tx.get(ref as unknown as FsDocRef);
        if (doc.exists && (doc.data() as PointerDoc | undefined)?.publishedSlot) return;
        tx.set(ref as unknown as FsDocRef, { publishedSlot, draftSlot: null }, { merge: true });
      });
    },

    async createDraft(namespace, audit) {
      // O(1): a draft is an EMPTY overlay on top of published — NO graph copy.
      // A draft read merges published + this (empty) overlay, so it reads
      // identical to published until the first edit lands via applyDelta.
      const existing = await fetchPointer(namespace);
      if (!existing) throw new Error(`createDraft: namespace '${namespace}' has no pointer — run the seed first.`);
      if (existing.draftSlot) return; // idempotent — a draft already exists

      const from = existing.publishedSlot;
      const to = otherSlot(from);

      // Clear any stragglers in the target overlay slot before opening the draft,
      // so a prior draft's leftover overlay docs can't pollute the merge. Normally
      // empty (discard/publish clean up) — O(overlay), not O(graph). The rare
      // exception (a full graph left in `to` by a crashed large publish) is
      // cleaned here too.
      const [staleNodes, staleEdges] = await Promise.all([
        db.collection(NODES).where("namespace", "==", namespace).where("slot", "==", to).get(),
        db.collection(EDGES).where("namespace", "==", namespace).where("slot", "==", to).get(),
      ]);
      await Promise.all([
        commitInChunks(db, staleNodes.docs.map((d) => d.ref), (b, r) => { b.delete(r); }, "createDraft.clearNodes"),
        commitInChunks(db, staleEdges.docs.map((d) => d.ref), (b, r) => { b.delete(r); }, "createDraft.clearEdges"),
      ]);

      // Flip draftSlot in a transaction that re-checks the pointer, so a racing
      // createDraft or a concurrent publish can't leave inconsistent state.
      await db.runTransaction(async (tx) => {
        const ref = pointerRef(namespace);
        const doc = await tx.get(ref as unknown as FsDocRef);
        const p = (doc.data() as PointerDoc | undefined) ?? null;
        if (!p) throw new Error(`createDraft: pointer for '${namespace}' vanished mid-op.`);
        if (p.publishedSlot !== from) throw new Error(`createDraft: '${namespace}' was published concurrently; retry.`);
        if (p.draftSlot) return; // another createDraft finished first — accept it (no audit either)
        // Carry the published slot's meta AND profile config into the new draft
        // cell, so the draft opens from the published profile.
        tx.update(ref as unknown as FsDocRef, {
          draftSlot: to,
          [metaField(to)]: p[metaField(from)] ?? null,
          [configField(to)]: p[configField(from)] ?? null,
        });
        if (audit) tx.set(db.collection(AUDIT).doc(audit.id) as unknown as FsDocRef, audit as unknown as Record<string, unknown>);
      });
    },

    async publishDraft(namespace, audit) {
      // Publish = apply the draft's overlay onto canonical, then clear the draft.
      // SIZE-ADAPTIVE (always atomic — see O1 in the design note):
      //   • small overlay  → one transaction: apply upserts/tombstones onto the
      //     canonical (published) slot, clear the overlay, promote meta/config,
      //     null draftSlot. Published slot does NOT move.
      //   • large overlay  → materialize canonical+overlay into the draft slot as
      //     a full graph, then an atomic pointer swap makes it the new published
      //     slot; the old canonical slot is cleaned afterwards.
      const nodeSlotQuery = (slot: Slot) => db.collection(NODES).where("namespace", "==", namespace).where("slot", "==", slot);
      const edgeSlotQuery = (slot: Slot) => db.collection(EDGES).where("namespace", "==", namespace).where("slot", "==", slot);
      const stripTomb = (d: Record<string, unknown>) => { const { [TOMBSTONE]: _t, ...rest } = d; return rest; };

      const p0 = await fetchPointer(namespace);
      if (!p0) throw new Error(`publishDraft: namespace '${namespace}' has no pointer.`);
      if (!p0.draftSlot) throw new Error(`publishDraft: namespace '${namespace}' has no draft to publish.`);
      const draftSlot = p0.draftSlot;
      const pub = p0.publishedSlot;

      const [ovN, ovE] = await Promise.all([nodeSlotQuery(draftSlot).get(), edgeSlotQuery(draftSlot).get()]);

      if (ovN.docs.length + ovE.docs.length <= PUBLISH_TXN_MAX) {
        // ── Small: one atomic transaction (re-reads the overlay in-tx) ────────
        await db.runTransaction(async (tx) => {
          const pRef = pointerRef(namespace);
          const p = ((await tx.get(pRef as unknown as FsDocRef)).data() as PointerDoc | undefined) ?? null;
          if (!p || p.draftSlot !== draftSlot) throw new Error(`publishDraft: '${namespace}' draft moved mid-publish; retry.`);
          const [txN, txE] = await Promise.all([tx.get(nodeSlotQuery(draftSlot)), tx.get(edgeSlotQuery(draftSlot))]);
          for (const d of txN.docs) {
            const data = d.data() as Record<string, unknown>;
            const canonRef = db.collection(NODES).doc(docId(namespace, pub, data.id as string)) as unknown as FsDocRef;
            if (data[TOMBSTONE]) tx.delete(canonRef); else tx.set(canonRef, { ...stripTomb(data), slot: pub });
            tx.delete(d.ref);
          }
          for (const d of txE.docs) {
            const data = d.data() as Record<string, unknown>;
            const canonRef = db.collection(EDGES).doc(docId(namespace, pub, data.id as string)) as unknown as FsDocRef;
            if (data[TOMBSTONE]) tx.delete(canonRef); else tx.set(canonRef, { ...stripTomb(data), slot: pub });
            tx.delete(d.ref);
          }
          // Promote the draft's meta/config onto the (unchanged) published slot,
          // and clear the draft cells.
          tx.update(pRef as unknown as FsDocRef, {
            draftSlot: null,
            [metaField(pub)]: p[metaField(draftSlot)] ?? p[metaField(pub)] ?? null,
            [configField(pub)]: p[configField(draftSlot)] ?? p[configField(pub)] ?? null,
            [metaField(draftSlot)]: null,
            [configField(draftSlot)]: null,
          });
          if (audit) tx.set(db.collection(AUDIT).doc(audit.id) as unknown as FsDocRef, audit as unknown as Record<string, unknown>);
        });
        return;
      }

      // ── Large: materialize into the draft slot, then atomic swap ────────────
      const [canonN, canonE] = await Promise.all([nodeSlotQuery(pub).get(), edgeSlotQuery(pub).get()]);
      const mergedN = mergeOverlay(canonN.docs.map((d) => d.data() as StoredNode), ovN.docs.map((d) => d.data() as Record<string, unknown>));
      const mergedE = mergeOverlay(canonE.docs.map((d) => d.data() as StoredEdge), ovE.docs.map((d) => d.data() as Record<string, unknown>));
      const mergedNodeDocIds = new Set(mergedN.map((n) => docId(namespace, draftSlot, n.id)));
      const mergedEdgeDocIds = new Set(mergedE.map((e) => docId(namespace, draftSlot, e.id)));
      // Overlay docs the merge doesn't keep (tombstones) must be deleted from the
      // draft slot so the materialized graph has no leftover markers.
      const staleOverlayN = ovN.docs.filter((d) => !mergedNodeDocIds.has(d.id)).map((d) => d.ref);
      const staleOverlayE = ovE.docs.filter((d) => !mergedEdgeDocIds.has(d.id)).map((d) => d.ref);
      await Promise.all([
        commitInChunks(db, mergedN, (b, n) => { b.set(db.collection(NODES).doc(docId(namespace, draftSlot, n.id)) as unknown as FsDocRef, { ...n, slot: draftSlot }); }, "publish.materializeNodes"),
        commitInChunks(db, mergedE, (b, e) => { b.set(db.collection(EDGES).doc(docId(namespace, draftSlot, e.id)) as unknown as FsDocRef, { ...e, slot: draftSlot }); }, "publish.materializeEdges"),
        commitInChunks(db, staleOverlayN, (b, r) => { b.delete(r); }, "publish.clearOverlayNodes"),
        commitInChunks(db, staleOverlayE, (b, r) => { b.delete(r); }, "publish.clearOverlayEdges"),
      ]);
      // Atomic swap: the freshly materialized draft slot becomes published. Its
      // meta/config cell already holds the draft's, so publishing just flips the
      // pointer. No reader observed a partial graph — the materialize wrote to the
      // (invisible) draft slot only.
      await db.runTransaction(async (tx) => {
        const pRef = pointerRef(namespace);
        const p = ((await tx.get(pRef as unknown as FsDocRef)).data() as PointerDoc | undefined) ?? null;
        if (!p || p.draftSlot !== draftSlot) throw new Error(`publishDraft: '${namespace}' draft moved mid-publish; retry.`);
        tx.update(pRef as unknown as FsDocRef, { publishedSlot: draftSlot, draftSlot: null });
        if (audit) tx.set(db.collection(AUDIT).doc(audit.id) as unknown as FsDocRef, audit as unknown as Record<string, unknown>);
      });
      // Clean the old canonical slot (now scratch) so the next createDraft's
      // target is empty. Off the critical path — published already flipped.
      await Promise.all([
        commitInChunks(db, canonN.docs.map((d) => d.ref), (b, r) => { b.delete(r); }, "publish.cleanOldNodes"),
        commitInChunks(db, canonE.docs.map((d) => d.ref), (b, r) => { b.delete(r); }, "publish.cleanOldEdges"),
      ]);
    },

    async discardDraft(namespace, audit) {
      const p0 = await fetchPointer(namespace);
      if (!p0 || !p0.draftSlot) return; // idempotent no-op — no audit either
      const draftSlot = p0.draftSlot;

      // Delete the draft's overlay docs (small — only what the session changed),
      // so the slot is empty for the next createDraft.
      const [ovN, ovE] = await Promise.all([
        db.collection(NODES).where("namespace", "==", namespace).where("slot", "==", draftSlot).get(),
        db.collection(EDGES).where("namespace", "==", namespace).where("slot", "==", draftSlot).get(),
      ]);
      await Promise.all([
        commitInChunks(db, ovN.docs.map((d) => d.ref), (b, r) => { b.delete(r); }, "discard.clearNodes"),
        commitInChunks(db, ovE.docs.map((d) => d.ref), (b, r) => { b.delete(r); }, "discard.clearEdges"),
      ]);

      // Clear the pointer's draft state + cells (transaction re-checks the draft
      // is still the one we cleared).
      await db.runTransaction(async (tx) => {
        const ref = pointerRef(namespace);
        const p = ((await tx.get(ref as unknown as FsDocRef)).data() as PointerDoc | undefined) ?? null;
        if (!p || p.draftSlot !== draftSlot) return; // someone else changed it — leave their state
        tx.update(ref as unknown as FsDocRef, { draftSlot: null, [metaField(draftSlot)]: null, [configField(draftSlot)]: null });
        if (audit) tx.set(db.collection(AUDIT).doc(audit.id) as unknown as FsDocRef, audit as unknown as Record<string, unknown>);
      });
    },

    // ── Append-only audit surface ──────────────────────────────────────────
    // appendAudit is only used for records that do NOT accompany a state
    // change (blocked attempts). Records that DO accompany a state change
    // ride the call's `audit` parameter and are committed inside the same
    // transaction as the state write — see writeSlot / createDraft /
    // publishDraft / discardDraft above.
    async appendAudit(record) {
      // create-style write on a fresh doc id — never an update / delete.
      await db.collection(AUDIT).doc(record.id).set(record as unknown as Record<string, unknown>);
    },

    // ── Pending confirm payloads ────────────────────────────────────────────
    // Plain single-doc set/get/delete — no transaction needed. The doc id folds
    // in the nonce (already unique), so two ops never collide. `expiresAt` is
    // stored for a TTL policy; readPending also enforces it so an expired entry
    // reads as absent even without one configured.
    async putPending(namespace, nonce, entry) {
      await db.collection(PENDING).doc(`${nsSlug(namespace)}::${nonce}`).set({ namespace, nonce, ...entry } as unknown as Record<string, unknown>);
    },
    async readPending(namespace, nonce) {
      const doc = await db.collection(PENDING).doc(`${nsSlug(namespace)}::${nonce}`).get();
      if (!doc.exists) return null;
      const data = doc.data() as (PendingEntry & Record<string, unknown>) | undefined;
      if (!data) return null;
      if (Date.now() > data.expiresAt) { await doc.ref.delete(); return null; }
      return { op: data.op, proposedHash: data.proposedHash, payload: data.payload, expiresAt: data.expiresAt };
    },
    async deletePending(namespace, nonce) {
      await db.collection(PENDING).doc(`${nsSlug(namespace)}::${nonce}`).delete();
    },

    async listAudit(query) {
      // Coarse filter server-side by whatever's easiest to index (namespace,
      // eventType, actorId, ts range), then re-run matchesAuditQuery locally
      // to enforce the exact contract regardless of how many predicates
      // Firestore accepted in one composite query.
      let q: FsQuery = db.collection(AUDIT);
      if (query.namespace != null) q = (q as FsCollection).where("namespace", "==", query.namespace);
      if (query.eventType != null) q = (q as FsCollection).where("eventType", "==", query.eventType);
      if (query.actorId != null) q = (q as FsCollection).where("actor.id", "==", query.actorId);
      if (query.sinceTs != null) q = (q as FsCollection).where("ts", ">=", query.sinceTs);
      if (query.untilTs != null) q = (q as FsCollection).where("ts", "<=", query.untilTs);
      const snap = await q.get();
      const rows = snap.docs.map((d) => d.data() as AuditRecord).filter((r) => matchesAuditQuery(r, query));
      return sortAuditNewestFirst(rows).slice(0, query.limit ?? Infinity);
    },
  };
}
