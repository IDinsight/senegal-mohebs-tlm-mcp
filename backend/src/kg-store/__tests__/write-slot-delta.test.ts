/*
 * writeSlotDelta — the O(delta) in-place replace of a REAL slot.
 *
 * Unlike applyDelta (which writes onto the draft OVERLAY and tombstones a removed
 * id), writeSlotDelta targets a real/published slot, so a removed id is a genuine
 * delete. import-kg --replace-published uses it to avoid rewriting every doc (the
 * full rewrite is what times out over a slow link). The memory backend mirrors
 * the Firestore backend's semantics, so asserting behaviour here covers both.
 */
import { describe, it, expect } from "vitest";
import { createMemoryKgStore } from "../index.js";
import type { StoredEdge, StoredMeta, StoredNode } from "../types.js";

const ns = "ws/gr/su";
const meta = (nodeCount: number, edgeCount: number): StoredMeta => ({
  contentHash: "h", seededAt: "1970-01-01T00:00:00Z", adapterId: "test", nodeCount, edgeCount,
});
const node = (id: string, title: string): Omit<StoredNode, "slot"> => ({
  id, type: "lesson", namespace: ns, properties: { title }, labels: ["Lesson"], spine: true,
});
const edge = (from: string, to: string): Omit<StoredEdge, "slot"> => ({
  id: `hasPart:${from}->${to}`, type: "hasPart", from, to, namespace: ns, properties: {},
});

describe("writeSlotDelta", () => {
  it("upserts changed/added docs and really deletes removed ones", async () => {
    const store = createMemoryKgStore();
    await store.writeSlot(ns, "a", {
      nodes: [node("n1", "one"), node("n2", "two"), node("n3", "three")],
      edges: [edge("n1", "n2")],
      meta: meta(3, 1),
    });
    await store.ensurePointer(ns, "a");

    // Change n1, add n4, drop n3; swap the edge.
    await store.writeSlotDelta(ns, "a", {
      upsertNodes: [node("n1", "ONE"), node("n4", "four")],
      upsertEdges: [edge("n1", "n4")],
      removeNodeIds: ["n3"],
      removeEdgeIds: ["hasPart:n1->n2"],
    }, meta(3, 1));

    const byId = new Map((await store.listNodes(ns, "a")).map((n) => [n.id, n]));
    expect([...byId.keys()].sort()).toEqual(["n1", "n2", "n4"]); // n3 gone, n4 added
    expect(byId.get("n1")!.properties.title).toBe("ONE");        // n1 replaced
    expect(byId.get("n1")!.slot).toBe("a");                      // slot re-stamped

    const edges = await store.listEdges(ns, "a");
    expect(edges.map((e) => e.id)).toEqual(["hasPart:n1->n4"]);  // old edge gone
  });

  it("stamps the new meta and leaves untouched docs alone", async () => {
    const store = createMemoryKgStore();
    await store.writeSlot(ns, "a", { nodes: [node("keep", "k"), node("drop", "d")], edges: [], meta: meta(2, 0) });
    await store.ensurePointer(ns, "a");

    await store.writeSlotDelta(ns, "a", { upsertNodes: [], upsertEdges: [], removeNodeIds: ["drop"], removeEdgeIds: [] }, meta(1, 0));

    expect((await store.listNodes(ns, "a")).map((n) => n.id)).toEqual(["keep"]);
    expect((await store.readMeta(ns, "a"))?.nodeCount).toBe(1);
  });
});
