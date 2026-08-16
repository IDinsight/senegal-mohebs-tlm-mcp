// ── kg-recipes — the BATCHED verbs (add_nodes / create_edges) ────────────────
// Both fold the single-item verb over an accumulating graph, so the whole batch
// is ONE mutation → one diff → one confirmation token → one apply audit record
// (the use_routine shape). These tests cover: batch happy path + combined diff,
// ONE apply record for the whole batch, atomic rollback when any item is
// invalid (no token, no partial apply), sequential auto-positioning, duplicate
// detection across the batch AND the draft, and namespace isolation.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { listAvailableContexts } from "../../context/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, mintNodeId, edgeId as makeEdgeId,
  __resetMutationsForTest, __resetDraftTokensForTest,
} from "../../kg-store/index.js";
import { addNodes, createEdges, type AddNodesItem, type CreateEdgesItem } from "../index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import type { MutationGraph, GraphMutation, StoredMeta, KgNodeStore } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const HAS_PART = "hasPart";

const emptyHistory: HistoryFile = { version: 3, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [], getObjectMd5: async () => null, downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory, writeHistory: async () => {},
};
const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const ns = kgNamespace("ci", "maths");
const readingNs = kgNamespace("ce1", "reading");
const adapter = () => resolveAdapter("ci", "maths")!;

async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const subjectAdapter = resolveAdapter(grade, subject);
    if (!subjectAdapter) continue;
    const { nodes, edges } = serializeModel(subjectAdapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: subjectAdapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await freshStore.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await freshStore.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return freshStore;
}

const strip = <T extends { slot?: unknown }>(record: T) => {
  const { slot: _slot, ...rest } = record;
  return rest;
};
async function readSlot(namespace: string, slot: "a" | "b"): Promise<MutationGraph> {
  const [nodes, edges] = await Promise.all([store.listNodes(namespace, slot), store.listEdges(namespace, slot)]);
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}
async function readPublished(namespace = ns): Promise<MutationGraph> {
  const pointer = await store.readPointer(namespace);
  return readSlot(namespace, pointer!.publishedSlot);
}
async function readDraft(namespace = ns): Promise<MutationGraph | null> {
  const pointer = await store.readPointer(namespace);
  return pointer?.draftSlot ? readSlot(namespace, pointer.draftSlot) : null;
}

// Confirm helper: preview → replay the token. Returns both phases.
async function run<A>(mutation: GraphMutation<A>, args: A) {
  const preview = await runGraphMutation({ namespace: ns, mutation, args });
  if (preview.phase !== "preview") {
    return { preview, confirm: null };
  }
  const confirm = await runGraphMutation({ namespace: ns, mutation, args, confirm: true, token: preview.confirmationToken });
  return { preview, confirm };
}

// The first chapter (a content LessonGrouping) — a stable parent to attach a
// batch of new Lessons under.
function firstChapterId(graph: MutationGraph): string {
  const chapter = graph.nodes
    .filter((node) => (node.labels ?? []).includes("LessonGrouping"))
    .find((node) => (node.properties?.raw as Record<string, unknown> | undefined)?.groupName === "Chapitre");
  return chapter!.id;
}

// Build N add_nodes items creating Lessons under one parent, each with a fresh
// minted id.
function lessonItems(parentId: string, count: number): AddNodesItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    label: "Lesson",
    parentId,
    newNodeId: mintNodeId(),
    title: `Batch lesson ${index + 1}`,
  }));
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  __resetDraftTokensForTest();
  __setActorForTest(CURATOR);
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE; else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

describe("add_nodes (batched)", () => {
  it("creates many nodes in ONE diff, ONE apply record, with sequential positions", async () => {
    const published = await readPublished();
    const parentId = firstChapterId(published);
    const items = lessonItems(parentId, 3);
    const args = { namespace: ns, items };

    const preview = await runGraphMutation({ namespace: ns, mutation: addNodes, args });
    if (preview.phase !== "preview") throw new Error("expected preview");

    // One combined diff: all three nodes + their three hasPart edges.
    expect(preview.diff.nodes.added.map((node) => node.id).sort()).toEqual(items.map((item) => item.newNodeId).sort());
    for (const item of items) {
      expect(preview.diff.edges.added.map((edge) => edge.id)).toContain(makeEdgeId(HAS_PART, parentId, item.newNodeId));
    }
    expect(await readDraft()).toBeNull(); // dry-run stages nothing

    const confirm = await runGraphMutation({ namespace: ns, mutation: addNodes, args, confirm: true, token: preview.confirmationToken });
    expect(confirm.phase).toBe("apply");

    // Exactly ONE apply audit record for the whole batch, carrying the combined diff.
    const applyRecords = await store.listAudit({ namespace: ns, eventType: "apply" });
    expect(applyRecords.length).toBe(1);
    expect(applyRecords[0].diff!.nodes.added.length).toBe(3);

    // Positions auto-increment across the batch (item 2 saw item 1's node).
    const draft = (await readDraft())!;
    const positions = items.map((item) => draft.nodes.find((node) => node.id === item.newNodeId)!.properties.order as number);
    expect(new Set(positions).size).toBe(3);
    expect(positions[1]).toBe(positions[0] + 1);
    expect(positions[2]).toBe(positions[1] + 1);
  });

  it("blocks the WHOLE batch if any item is invalid — no token, no partial apply", async () => {
    const published = await readPublished();
    const parentId = firstChapterId(published);
    const goodItem = lessonItems(parentId, 1)[0];
    const badItem: AddNodesItem = { label: "NotARealLabel", parentId, newNodeId: mintNodeId(), title: "nope" };

    const preview = await runGraphMutation({ namespace: ns, mutation: addNodes, args: { namespace: ns, items: [goodItem, badItem] } });
    expect(preview.phase).toBe("blocked");
    if (preview.phase !== "blocked") throw new Error("expected blocked");
    expect(preview.errors.some((error) => error.includes("add_nodes[1]"))).toBe(true);
    expect("confirmationToken" in preview).toBe(false);

    // The valid item was NOT applied either — nothing staged.
    expect(await readDraft()).toBeNull();
  });

  it("rejects an item parented to another item's freshly-minted id (existing parents only)", async () => {
    const published = await readPublished();
    const courseId = published.nodes.find((node) => (node.labels ?? []).includes("Course"))!.id;

    const newGrouping: AddNodesItem = { label: "LessonGrouping", parentId: courseId, newNodeId: mintNodeId(), title: "Fresh unit" };
    const childOfNewGrouping: AddNodesItem = { label: "Lesson", parentId: newGrouping.newNodeId, newNodeId: mintNodeId(), title: "child" };

    const preview = await runGraphMutation({ namespace: ns, mutation: addNodes, args: { namespace: ns, items: [newGrouping, childOfNewGrouping] } });
    expect(preview.phase).toBe("blocked");
    if (preview.phase !== "blocked") throw new Error("expected blocked");
    expect(preview.errors.some((error) => error.includes("EXISTING parent"))).toBe(true);
  });

  it("does not touch a sibling namespace (isolation)", async () => {
    const readingBefore = (await readPublished(readingNs)).nodes.length;
    const parentId = firstChapterId(await readPublished());

    const { confirm } = await run(addNodes, { namespace: ns, items: lessonItems(parentId, 2) });
    expect(confirm?.phase).toBe("apply");

    // ce1/reading has no draft and its published node count is unchanged.
    expect(await readDraft(readingNs)).toBeNull();
    expect((await readPublished(readingNs)).nodes.length).toBe(readingBefore);
  });
});

describe("create_edges (batched)", () => {
  // Pick `count` edges of an already-observed type between node pairs that are
  // NOT already connected by it — so they are structurally valid, non-duplicate
  // new edges (create_edges enforces no domain/range, only existence + no dup).
  function freshEdges(graph: MutationGraph, count: number): CreateEdgesItem[] {
    const edgeType = graph.edges[0].type;
    const existingIds = new Set(graph.edges.map((edge) => edge.id));
    const nodeIds = graph.nodes.map((node) => node.id);
    const fresh: CreateEdgesItem[] = [];
    for (const fromId of nodeIds) {
      for (const toId of nodeIds) {
        if (fresh.length >= count) {
          return fresh;
        }
        if (fromId === toId) {
          continue;
        }
        const id = makeEdgeId(edgeType, fromId, toId);
        if (existingIds.has(id)) {
          continue;
        }
        existingIds.add(id);
        fresh.push({ edgeType, fromId, toId });
      }
    }
    return fresh;
  }

  it("adds many edges in ONE diff + ONE apply record", async () => {
    const published = await readPublished();
    const edges = freshEdges(published, 3);
    const args = { namespace: ns, edges };

    const preview = await runGraphMutation({ namespace: ns, mutation: createEdges, args });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.diff.edges.added.length).toBe(3);
    expect(preview.diff.nodes.added.length).toBe(0); // edges only

    const confirm = await runGraphMutation({ namespace: ns, mutation: createEdges, args, confirm: true, token: preview.confirmationToken });
    expect(confirm.phase).toBe("apply");

    const applyRecords = await store.listAudit({ namespace: ns, eventType: "apply" });
    expect(applyRecords.length).toBe(1);
    expect(applyRecords[0].diff!.edges.added.length).toBe(3);
  });

  it("rejects a duplicate WITHIN the batch (same triple twice)", async () => {
    const published = await readPublished();
    const [edge] = freshEdges(published, 1);

    const preview = await runGraphMutation({ namespace: ns, mutation: createEdges, args: { namespace: ns, edges: [edge, edge] } });
    expect(preview.phase).toBe("blocked");
    if (preview.phase !== "blocked") throw new Error("expected blocked");
    expect(preview.errors.some((error) => error.includes("create_edges[1]") && error.includes("already exists"))).toBe(true);
  });

  it("rejects a duplicate against the current DRAFT (an edge that already exists)", async () => {
    const published = await readPublished();
    const existing = published.edges[0];
    const duplicate: CreateEdgesItem = { edgeType: existing.type, fromId: existing.from, toId: existing.to };

    const preview = await runGraphMutation({ namespace: ns, mutation: createEdges, args: { namespace: ns, edges: [duplicate] } });
    expect(preview.phase).toBe("blocked");
  });

  it("blocks the whole batch when any edge has a missing endpoint (atomic)", async () => {
    const published = await readPublished();
    const good = freshEdges(published, 1)[0];
    const bad: CreateEdgesItem = { edgeType: good.edgeType, fromId: "does-not-exist", toId: good.toId };

    const preview = await runGraphMutation({ namespace: ns, mutation: createEdges, args: { namespace: ns, edges: [good, bad] } });
    expect(preview.phase).toBe("blocked");
    expect(await readDraft()).toBeNull();
  });
});
