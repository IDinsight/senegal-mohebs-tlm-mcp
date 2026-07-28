// ── Module: kg-store · internal ──────────────────────────────────────────────
// Firestore-backed KgNodeStore. Two top-level collections (`kg_nodes`,
// `kg_edges`) each carrying a `namespace` field; a `kg_meta` collection holds
// the per-namespace provenance stamp. Every document id is `${nsSlug}::${id}`
// so a re-seed overwrites in place, and a namespace's data is retrieved by a
// single field query — no fan-out reads.
//
// Firebase Admin is initialised the same way `storage/firebase.ts` does it
// (key file, key JSON, or ADC). The SDK dedupes app initialisation, so both
// modules can call it independently without stepping on each other.
import { createRequire } from "node:module";
import { CONFIG } from "../config.js";
import type { KgNodeStore, StoredEdge, StoredMeta, StoredNode } from "./types.js";

const require = createRequire(import.meta.url);

// Minimal Firestore type surface. Kept structural to avoid a hard dependency on
// firebase-admin's exported types at compile time.
interface FsDoc {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
  ref: FsDocRef;
}
interface FsDocRef {
  set(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}
interface FsQuerySnap { docs: FsDoc[] }
interface FsQuery { get(): Promise<FsQuerySnap> }
interface FsCollection extends FsQuery {
  doc(id: string): { get(): Promise<FsDoc>; set(data: Record<string, unknown>): Promise<unknown>; delete(): Promise<unknown> };
  where(field: string, op: string, value: unknown): FsQuery;
}
interface FsBatch { set(ref: FsDocRef, data: Record<string, unknown>): FsBatch; delete(ref: FsDocRef): FsBatch; commit(): Promise<unknown> }
interface Firestore {
  collection(name: string): FsCollection;
  batch(): FsBatch;
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
// is flattened. Meta docs use the flat form directly as their id.
const nsSlug = (ns: string) => ns.replace(/\//g, "__");
const NODES = "kg_nodes";
const EDGES = "kg_edges";
const META = "kg_meta";
// Firestore caps a WriteBatch at 500 operations. We stay a bit under to leave
// room for a trailing meta write in the same seed run.
const BATCH_MAX = 450;

async function commitInChunks<T>(items: T[], apply: (batch: FsBatch, item: T) => void): Promise<void> {
  const db = fbFirestore.getFirestore();
  for (let i = 0; i < items.length; i += BATCH_MAX) {
    const b = db.batch();
    for (const item of items.slice(i, i + BATCH_MAX)) apply(b, item);
    await b.commit();
  }
}

export function createFirestoreKgStore(): KgNodeStore {
  initFirebase();
  const db = fbFirestore.getFirestore();

  return {
    kind: "firestore",

    async listNodes(namespace) {
      const snap = await db.collection(NODES).where("namespace", "==", namespace).get();
      return snap.docs.map((d) => d.data() as StoredNode);
    },

    async listEdges(namespace) {
      const snap = await db.collection(EDGES).where("namespace", "==", namespace).get();
      return snap.docs.map((d) => d.data() as StoredEdge);
    },

    async readMeta(namespace) {
      const doc = await db.collection(META).doc(nsSlug(namespace)).get();
      return doc.exists ? ((doc.data() as StoredMeta) ?? null) : null;
    },

    async writeNamespace(namespace, batch) {
      // Idempotency: compute the target ids, upsert them, and delete any stale
      // ids that are no longer present. Re-running with identical input hits
      // the delete branch zero times and leaves the store bit-for-bit the same.
      const [existingNodes, existingEdges] = await Promise.all([
        db.collection(NODES).where("namespace", "==", namespace).get(),
        db.collection(EDGES).where("namespace", "==", namespace).get(),
      ]);
      const targetNodeIds = new Set(batch.nodes.map((n) => nsSlug(namespace) + "::" + n.id));
      const targetEdgeIds = new Set(batch.edges.map((e) => nsSlug(namespace) + "::" + e.id));

      const nodeWrites = batch.nodes.map((n) => ({ ref: db.collection(NODES).doc(nsSlug(namespace) + "::" + n.id), data: { ...n, namespace } }));
      const edgeWrites = batch.edges.map((e) => ({ ref: db.collection(EDGES).doc(nsSlug(namespace) + "::" + e.id), data: { ...e, namespace } }));
      const nodeDeletes = existingNodes.docs.filter((d) => !targetNodeIds.has(d.id)).map((d) => d.ref);
      const edgeDeletes = existingEdges.docs.filter((d) => !targetEdgeIds.has(d.id)).map((d) => d.ref);

      await commitInChunks(nodeWrites, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); });
      await commitInChunks(edgeWrites, (b, w) => { b.set(w.ref as unknown as FsDocRef, w.data); });
      await commitInChunks(nodeDeletes, (b, r) => { b.delete(r); });
      await commitInChunks(edgeDeletes, (b, r) => { b.delete(r); });

      // Meta last: an interrupted seed shows up as a namespace with no meta
      // doc, which the schema guard treats as unseeded and refuses to load.
      await db.collection(META).doc(nsSlug(namespace)).set({ ...batch.meta, namespace });
    },
  };
}
