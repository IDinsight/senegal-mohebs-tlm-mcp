// ── Module: kg-store · internal ──────────────────────────────────────────────
// Firestore-backed KgNodeStore. Three top-level collections:
//   kg_nodes    — {namespace, slot, id, type, properties, …}
//   kg_edges    — {namespace, slot, id, type, from, to, properties, …}
//   kg_pointers — one doc per namespace: {publishedSlot, draftSlot|null}
//                 the atomic swap point for the draft/published lifecycle.
// A per-namespace meta stamp lives on the pointer doc (one field per slot),
// so it participates in the same transactional writes as the pointer itself.
//
// Doc ids are `${nsSlug}::${slot}::${id}` so slot A and slot B can hold two
// copies of the same node id side by side without collision.
//
// Firebase Admin is initialised the same way `storage/firebase.ts` does it
// (key file, key JSON, or ADC). The SDK dedupes app initialisation, so both
// modules can call it independently without stepping on each other.
import { createRequire } from "node:module";
import { CONFIG } from "../config.js";
import type { KgNodeStore, Slot, StoredEdge, StoredMeta, StoredNode, StoredPointer } from "./types.js";
import { otherSlot } from "./types.js";

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
// Firestore caps a WriteBatch at 500 operations. We stay a bit under to leave
// headroom.
const BATCH_MAX = 450;

async function commitInChunks<T>(db: Firestore, items: T[], apply: (batch: FsBatch, item: T) => void): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_MAX) {
    const b = db.batch();
    for (const item of items.slice(i, i + BATCH_MAX)) apply(b, item);
    await b.commit();
  }
}

// Pointer doc layout. We keep the two per-slot meta stamps on the same doc as
// the pointer so a publish (which is transactional on the pointer) can also
// swap the "current" meta atomically.
type PointerDoc = {
  publishedSlot: Slot;
  draftSlot: Slot | null;
  metaA?: StoredMeta | null;
  metaB?: StoredMeta | null;
};
const metaField = (slot: Slot): "metaA" | "metaB" => (slot === "a" ? "metaA" : "metaB");

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

    async listNodes(namespace, slot) {
      const snap = await db.collection(NODES)
        .where("namespace", "==", namespace)
        .where("slot", "==", slot)
        .get();
      return snap.docs.map((d) => d.data() as StoredNode);
    },

    async listEdges(namespace, slot) {
      const snap = await db.collection(EDGES)
        .where("namespace", "==", namespace)
        .where("slot", "==", slot)
        .get();
      return snap.docs.map((d) => d.data() as StoredEdge);
    },

    async readMeta(namespace, slot) {
      const p = await fetchPointer(namespace);
      const stored = p ? p[metaField(slot)] : null;
      return stored ?? null;
    },

    async readPointer(namespace) {
      const p = await fetchPointer(namespace);
      if (!p) return null;
      return { publishedSlot: p.publishedSlot, draftSlot: p.draftSlot ?? null };
    },

    async writeSlot(namespace, slot, batch) {
      // Idempotency (per slot): upsert target ids, delete stragglers in this
      // slot only. The other slot is untouched — critical for createDraft's
      // copy phase not to disturb the published data.
      const [existingNodes, existingEdges] = await Promise.all([
        db.collection(NODES).where("namespace", "==", namespace).where("slot", "==", slot).get(),
        db.collection(EDGES).where("namespace", "==", namespace).where("slot", "==", slot).get(),
      ]);
      const targetNodeIds = new Set(batch.nodes.map((n) => docId(namespace, slot, n.id)));
      const targetEdgeIds = new Set(batch.edges.map((e) => docId(namespace, slot, e.id)));

      const nodeWrites = batch.nodes.map((n) => ({ ref: db.collection(NODES).doc(docId(namespace, slot, n.id)), data: { ...n, namespace, slot } }));
      const edgeWrites = batch.edges.map((e) => ({ ref: db.collection(EDGES).doc(docId(namespace, slot, e.id)), data: { ...e, namespace, slot } }));
      const nodeDeletes = existingNodes.docs.filter((d) => !targetNodeIds.has(d.id)).map((d) => d.ref);
      const edgeDeletes = existingEdges.docs.filter((d) => !targetEdgeIds.has(d.id)).map((d) => d.ref);

      await commitInChunks(db, nodeWrites, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); });
      await commitInChunks(db, edgeWrites, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); });
      await commitInChunks(db, nodeDeletes, (b, r) => { b.delete(r); });
      await commitInChunks(db, edgeDeletes, (b, r) => { b.delete(r); });

      // Stash the slot's meta on the pointer doc via a merge-preserving write.
      // The pointer's slot fields (publishedSlot/draftSlot) are handled by
      // ensurePointer / lifecycle ops; here we only touch the meta cell.
      await pointerRef(namespace).set({ [metaField(slot)]: { ...batch.meta } }, { merge: true });
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

    async createDraft(namespace) {
      // Read the current pointer OUTSIDE a transaction: the copy step itself
      // is long-running and cannot be inside a Firestore transaction (which
      // caps at 500 writes and a few seconds). Race safety is achieved by
      // setting the pointer's draftSlot LAST, inside a transaction that
      // re-reads the pointer to make sure nobody else set draftSlot first.
      const existing = await fetchPointer(namespace);
      if (!existing) throw new Error(`createDraft: namespace '${namespace}' has no pointer — run the seed first.`);
      if (existing.draftSlot) return; // idempotent — a draft already exists

      const from = existing.publishedSlot;
      const to = otherSlot(from);

      const [nodes, edges] = await Promise.all([
        db.collection(NODES).where("namespace", "==", namespace).where("slot", "==", from).get(),
        db.collection(EDGES).where("namespace", "==", namespace).where("slot", "==", from).get(),
      ]);
      const nodeCopies = nodes.docs.map((d) => {
        const src = d.data() as StoredNode;
        return { id: src.id, doc: { ...src, slot: to } };
      });
      const edgeCopies = edges.docs.map((d) => {
        const src = d.data() as StoredEdge;
        return { id: src.id, doc: { ...src, slot: to } };
      });

      // First, wipe any stragglers in the destination slot (from a prior
      // discarded draft that left orphans). Then upsert copies.
      const [staleNodes, staleEdges] = await Promise.all([
        db.collection(NODES).where("namespace", "==", namespace).where("slot", "==", to).get(),
        db.collection(EDGES).where("namespace", "==", namespace).where("slot", "==", to).get(),
      ]);
      await commitInChunks(db, staleNodes.docs.map((d) => d.ref), (b, r) => { b.delete(r); });
      await commitInChunks(db, staleEdges.docs.map((d) => d.ref), (b, r) => { b.delete(r); });
      await commitInChunks(db, nodeCopies, (b, w) => { b.set(db.collection(NODES).doc(docId(namespace, to, w.id)) as unknown as FsDocRef, w.doc as unknown as Record<string, unknown>); });
      await commitInChunks(db, edgeCopies, (b, w) => { b.set(db.collection(EDGES).doc(docId(namespace, to, w.id)) as unknown as FsDocRef, w.doc as unknown as Record<string, unknown>); });

      // Finally, flip draftSlot in a transaction so a racing createDraft that
      // beat us to the copy phase doesn't silently overwrite each other's
      // pointer state.
      await db.runTransaction(async (tx) => {
        const ref = pointerRef(namespace);
        const doc = await tx.get(ref as unknown as FsDocRef);
        const p = (doc.data() as PointerDoc | undefined) ?? null;
        if (!p) throw new Error(`createDraft: pointer for '${namespace}' vanished mid-op.`);
        if (p.publishedSlot !== from) {
          // Someone else published between our read and our write — our copy
          // is now against a stale published version. Bail rather than commit
          // an inconsistent pointer; a retry will read the new published slot.
          throw new Error(`createDraft: '${namespace}' was published concurrently; retry.`);
        }
        if (p.draftSlot) return; // another createDraft finished first — accept it
        tx.update(ref as unknown as FsDocRef, { draftSlot: to, [metaField(to)]: p[metaField(from)] ?? null });
      });
    },

    async publishDraft(namespace) {
      // Single-doc transaction: read current pointer, flip published/draft.
      // Atomic by Firestore's single-doc write guarantee — no reader ever
      // observes a partial state.
      await db.runTransaction(async (tx) => {
        const ref = pointerRef(namespace);
        const doc = await tx.get(ref as unknown as FsDocRef);
        const p = (doc.data() as PointerDoc | undefined) ?? null;
        if (!p) throw new Error(`publishDraft: namespace '${namespace}' has no pointer.`);
        if (!p.draftSlot) throw new Error(`publishDraft: namespace '${namespace}' has no draft to publish.`);
        tx.update(ref as unknown as FsDocRef, { publishedSlot: p.draftSlot, draftSlot: null });
      });
    },

    async discardDraft(namespace) {
      await db.runTransaction(async (tx) => {
        const ref = pointerRef(namespace);
        const doc = await tx.get(ref as unknown as FsDocRef);
        const p = (doc.data() as PointerDoc | undefined) ?? null;
        if (!p || !p.draftSlot) return; // idempotent no-op
        // Clear the draft slot's meta cell alongside the pointer so a fresh
        // createDraft doesn't inherit a stale meta.
        tx.update(ref as unknown as FsDocRef, { draftSlot: null, [metaField(p.draftSlot)]: null });
      });
    },
  };
}
