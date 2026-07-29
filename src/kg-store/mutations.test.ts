// ── Graph-mutation framework tests (memory backend) ─────────────────────────
// One internal test-only mutation (setNodeProperty) drives every acceptance
// criterion of the framework:
//   1. dry-run is a pure preview — no state changes; returns envelope + diff +
//      token; envelope's action string explicitly says "stages a draft edit".
//   2. confirm with a valid token applies to the DRAFT only; published is
//      byte-identical before/after.
//   3. confirm with a stale token (base moved) is rejected — nothing partial.
//   4. confirm cannot be replayed — the nonce is one-time.
//   5. If no draft exists at preview time, confirm creates one lazily.
//   6. args mismatch, mutation mismatch, malformed token, missing token all
//      surface distinct reasons.
//   7. Validate hook: errors → no token, blocked result; warnings → token
//      issued alongside the warnings.
//   8. Reusability: the same framework runs a second mutation shape without
//      any changes to the framework.
//   9. Document tools emit the shared envelope; graph and document `action`
//      strings state different stakes (draft-staged vs live write).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../config.js";
import { listAvailableContexts, subjectDir, newSessionState, runInSession } from "../context/index.js";
import { resolveAdapter } from "../adapters/index.js";
import { serializeModel } from "../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, __resetMutationsForTest,
} from "./index.js";
import { __setStorageForTest } from "../storage/index.js";
import type { GraphMutation, MutationGraph } from "./index.js";
import type { KgNodeStore, StoredMeta } from "./types.js";
import type { StorageAdapter, HistoryFile } from "../types.js";
import { buildConfirmEnvelope } from "../utils/index.js";

const emptyHistory: HistoryFile = { version: 2, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [],
  getObjectMd5: async () => null,
  downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory,
  writeHistory: async () => {},
};

// Internal test-only mutation. NOT exposed via registerTool anywhere — its
// only purpose is to exercise the framework. Sets `properties.testFlag` on
// one node keyed by stable id.
type SetPropArgs = { nodeId: string; key: string; value: unknown };
const setNodeProperty: GraphMutation<SetPropArgs> = {
  name: "test/setNodeProperty",
  describe: (a) => `set property '${a.key}' on node '${a.nodeId}'`,
  apply: (base, args) => ({
    nodes: base.nodes.map((n) =>
      n.id === args.nodeId ? { ...n, properties: { ...n.properties, [args.key]: args.value } } : n,
    ),
    edges: base.edges,
  }),
};

// A second mutation shape — proves reusability. Deletes a node by id.
type DeleteArgs = { nodeId: string };
const deleteNode: GraphMutation<DeleteArgs> = {
  name: "test/deleteNode",
  describe: (a) => `delete node '${a.nodeId}'`,
  apply: (base, args) => ({
    nodes: base.nodes.filter((n) => n.id !== args.nodeId),
    edges: base.edges.filter((e) => e.from !== args.nodeId && e.to !== args.nodeId),
  }),
};

// A validating mutation — proves the seam. Errors when args.value is null.
const validatingMutation: GraphMutation<SetPropArgs> = {
  name: "test/validating",
  describe: (a) => `validating set '${a.key}' on '${a.nodeId}'`,
  validate: (_base, args) => ({
    errors: args.value === null ? ["value must not be null"] : [],
    warnings: typeof args.value === "string" && args.value.length > 20 ? ["value is unusually long"] : [],
  }),
  apply: setNodeProperty.apply,
};

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const firstCtx = contexts[0];
const ns = kgNamespace(firstCtx.grade, firstCtx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(grade, subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = {
      contentHash: "test", seededAt: "1970-01-01T00:00:00Z",
      adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length,
    };
    await s.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return s;
}

async function readPublishedGraph(namespace: string): Promise<MutationGraph> {
  const pointer = await store.readPointer(namespace);
  const slot = pointer!.publishedSlot;
  const [nodes, edges] = await Promise.all([store.listNodes(namespace, slot), store.listEdges(namespace, slot)]);
  const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE;
  else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

describe("graph-mutation framework — preview (no confirm)", () => {
  it("returns the shared envelope extended with diff + warnings + token, changes NO state", async () => {
    const before = await readPublishedGraph(ns);
    const someNode = before.nodes[0];
    const state = newSessionState();
    const preview = await runInSession(state, () =>
      runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: someNode.id, key: "testFlag", value: 42 },
      }),
    );
    // Common (shared) envelope fields.
    expect(preview).toMatchObject({ needsConfirmation: true, kind: "graphMutation" });
    if (preview.phase !== "preview") throw new Error("expected a preview");
    expect(typeof preview.action).toBe("string");
    expect(typeof preview.message).toBe("string");
    expect(typeof preview.confirmationToken).toBe("string");
    // Graph-only extensions.
    expect(preview.diff.nodes.changed).toHaveLength(1);
    expect(preview.diff.nodes.changed[0].id).toBe(someNode.id);
    expect(preview.diff.nodes.added).toHaveLength(0);
    expect(preview.diff.nodes.removed).toHaveLength(0);
    expect(preview.warnings).toEqual([]);
    // No state change: pointer still says no draft; published untouched.
    expect(await store.readPointer(ns)).toEqual({ publishedSlot: "a", draftSlot: null });
    expect(await readPublishedGraph(ns)).toEqual(before);
  });

  it("action message states DRAFT-STAGED stakes (not a live write)", async () => {
    const before = await readPublishedGraph(ns);
    const state = newSessionState();
    const preview = await runInSession(state, () =>
      runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: before.nodes[0].id, key: "k", value: "v" },
      }),
    );
    if (preview.phase !== "preview") throw new Error("expected preview");
    // Positive: says "STAGES" and "draft" and mentions publish is separate.
    expect(preview.action.toLowerCase()).toMatch(/stages a draft edit/);
    expect(preview.action.toLowerCase()).toMatch(/publish/);
    // Negative: MUST NOT say "writes NOW" — that's the document tools' phrasing.
    expect(preview.action.toLowerCase()).not.toMatch(/writes now/);
  });
});

describe("graph-mutation framework — confirm", () => {
  it("with a valid token, applies to the DRAFT only; published stays byte-identical", async () => {
    const publishedBefore = await readPublishedGraph(ns);
    const targetId = publishedBefore.nodes[0].id;
    const preview = await runInSession(newSessionState(), () =>
      runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "testFlag", value: "hello" } }),
    );
    if (preview.phase !== "preview") throw new Error("preview");

    const applied = await runInSession(newSessionState(), () =>
      runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: targetId, key: "testFlag", value: "hello" },
        confirm: true, token: preview.confirmationToken,
      }),
    );
    expect(applied).toMatchObject({ ok: true, kind: "graphMutation", draftSlot: "b" });

    // Published slot must be byte-identical.
    const publishedAfter = await readPublishedGraph(ns);
    expect(publishedAfter).toEqual(publishedBefore);

    // Draft slot carries the change.
    const draftNodes = await store.listNodes(ns, "b");
    const changed = draftNodes.find((n) => n.id === targetId)!;
    expect((changed.properties as Record<string, unknown>).testFlag).toBe("hello");

    // Pointer advertises the draft.
    expect(await store.readPointer(ns)).toEqual({ publishedSlot: "a", draftSlot: "b" });
  });

  it("creates the draft lazily when none exists at preview time (byte-identical to published as its base)", async () => {
    expect((await store.readPointer(ns))?.draftSlot).toBe(null);
    const before = await readPublishedGraph(ns);
    const targetId = before.nodes[0].id;
    const preview = await runInSession(newSessionState(), () =>
      runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: 1 } }),
    );
    if (preview.phase !== "preview") throw new Error("preview");
    await runInSession(newSessionState(), () =>
      runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: targetId, key: "k", value: 1 },
        confirm: true, token: preview.confirmationToken,
      }),
    );
    // Draft was created by the framework — no explicit createDraft call.
    expect((await store.readPointer(ns))?.draftSlot).toBe("b");
  });

  it("rejects a stale token when the draft base has moved (no partial apply)", async () => {
    // Establish a draft with one prior mutation so subsequent previews target
    // 'onDraft'. Then race two previews: apply the second one, then try the
    // first — the base has moved, so the framework must reject.
    const before = await readPublishedGraph(ns);
    const targetId = before.nodes[0].id;
    const p1 = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: "a" } });
    if (p1.phase !== "preview") throw new Error("p1 preview");
    await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: "a" }, confirm: true, token: p1.confirmationToken });

    // Both previews now go against the draft. Apply p2; then p3 must be stale.
    const p2 = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: "b" } });
    if (p2.phase !== "preview") throw new Error("p2 preview");
    const p3 = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: "c" } });
    if (p3.phase !== "preview") throw new Error("p3 preview");
    await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: "b" }, confirm: true, token: p2.confirmationToken });

    // p3's base is now stale.
    const stale = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: "c" }, confirm: true, token: p3.confirmationToken });
    expect(stale).toMatchObject({ ok: false, reason: "stale" });

    // Draft must reflect only p2's value (no partial p3 apply).
    const draftNodes = await store.listNodes(ns, "b");
    expect((draftNodes.find((n) => n.id === targetId)!.properties as Record<string, unknown>).k).toBe("b");
  });

  it("rejects a token when a draft appeared between preview and confirm (onPublished → onDraft)", async () => {
    const before = await readPublishedGraph(ns);
    const targetId = before.nodes[0].id;
    // Preview A against published (no draft yet).
    const pA = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "kA", value: 1 } });
    if (pA.phase !== "preview") throw new Error("pA preview");
    // Preview + confirm B first — this creates the draft, so A's base slot
    // classification is no longer 'onPublished'.
    const pB = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "kB", value: 2 } });
    if (pB.phase !== "preview") throw new Error("pB preview");
    await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "kB", value: 2 }, confirm: true, token: pB.confirmationToken });

    const staleA = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "kA", value: 1 }, confirm: true, token: pA.confirmationToken });
    expect(staleA).toMatchObject({ ok: false, reason: "stale" });
  });

  it("cannot be replayed — a used token is a one-time thing", async () => {
    const before = await readPublishedGraph(ns);
    const targetId = before.nodes[0].id;
    const preview = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: 1 } });
    if (preview.phase !== "preview") throw new Error("preview");
    const first = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: 1 }, confirm: true, token: preview.confirmationToken });
    expect(first).toMatchObject({ ok: true });
    const second = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: 1 }, confirm: true, token: preview.confirmationToken });
    expect(second).toMatchObject({ ok: false, reason: "replay" });
  });

  it("rejects an args mismatch (guards against the client tampering with args between preview and confirm)", async () => {
    const before = await readPublishedGraph(ns);
    const targetId = before.nodes[0].id;
    const preview = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: "preview-value" } });
    if (preview.phase !== "preview") throw new Error("preview");
    const applied = await runGraphMutation({
      namespace: ns, mutation: setNodeProperty,
      args: { nodeId: targetId, key: "k", value: "different-value" }, // args changed
      confirm: true, token: preview.confirmationToken,
    });
    expect(applied).toMatchObject({ ok: false, reason: "argsMismatch" });
  });

  it("rejects a token issued for a different mutation", async () => {
    const before = await readPublishedGraph(ns);
    const targetId = before.nodes[0].id;
    const preview = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: targetId, key: "k", value: 1 } });
    if (preview.phase !== "preview") throw new Error("preview");
    const applied = await runGraphMutation({
      namespace: ns, mutation: deleteNode,
      args: { nodeId: targetId }, confirm: true, token: preview.confirmationToken,
    });
    expect(applied).toMatchObject({ ok: false, reason: "mutationMismatch" });
  });

  it("rejects a malformed or missing token", async () => {
    const before = await readPublishedGraph(ns);
    const noToken = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: before.nodes[0].id, key: "k", value: 1 }, confirm: true });
    expect(noToken).toMatchObject({ ok: false, reason: "invalidToken" });
    const garbage = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: before.nodes[0].id, key: "k", value: 1 }, confirm: true, token: "not-a-real-token" });
    expect(garbage).toMatchObject({ ok: false, reason: "invalidToken" });
  });
});

describe("graph-mutation framework — validate seam", () => {
  it("errors from validate block confirmation entirely (no token issued)", async () => {
    const before = await readPublishedGraph(ns);
    const blocked = await runGraphMutation({
      namespace: ns, mutation: validatingMutation,
      args: { nodeId: before.nodes[0].id, key: "k", value: null },
    });
    // Blocked result: no token, needsConfirmation === false explicitly.
    expect(blocked).toMatchObject({ needsConfirmation: false, kind: "graphMutation" });
    if (blocked.phase !== "blocked") throw new Error("expected blocked");
    expect(blocked.errors).toEqual(["value must not be null"]);
    expect("confirmationToken" in blocked).toBe(false);
  });

  it("warnings from validate ride alongside a normal preview envelope (token is issued)", async () => {
    const before = await readPublishedGraph(ns);
    const preview = await runGraphMutation({
      namespace: ns, mutation: validatingMutation,
      args: { nodeId: before.nodes[0].id, key: "k", value: "this-value-is-longer-than-twenty-chars" },
    });
    expect(preview).toMatchObject({ needsConfirmation: true });
    if (preview.phase !== "preview") throw new Error("preview");
    expect(preview.warnings).toEqual(["value is unusually long"]);
    expect(typeof preview.confirmationToken).toBe("string");
  });

  it("the default seam (no validate) is a pass-through with no errors and no warnings", async () => {
    const before = await readPublishedGraph(ns);
    const preview = await runGraphMutation({
      namespace: ns, mutation: setNodeProperty,
      args: { nodeId: before.nodes[0].id, key: "k", value: 1 },
    });
    if (preview.phase !== "preview") throw new Error("preview");
    expect(preview.warnings).toEqual([]);
  });
});

describe("graph-mutation framework — reusability & parity", () => {
  it("a second mutation shape works end-to-end without framework changes", async () => {
    const before = await readPublishedGraph(ns);
    const publishedBefore = { ...before };
    // Pick a leaf node so deletion doesn't cascade unpredictably. Any child of
    // the first root will do.
    const leaf = before.nodes.find((n) => !before.edges.some((e) => e.from === n.id))!;
    const preview = await runGraphMutation({ namespace: ns, mutation: deleteNode, args: { nodeId: leaf.id } });
    if (preview.phase !== "preview") throw new Error("preview");
    expect(preview.diff.nodes.removed).toHaveLength(1);
    expect(preview.diff.nodes.removed[0].id).toBe(leaf.id);

    const applied = await runGraphMutation({ namespace: ns, mutation: deleteNode, args: { nodeId: leaf.id }, confirm: true, token: preview.confirmationToken });
    expect(applied).toMatchObject({ ok: true });

    // Published byte-identical; draft lost the node (and any incident edges).
    expect(await readPublishedGraph(ns)).toEqual(publishedBefore);
    const draftNodes = await store.listNodes(ns, "b");
    expect(draftNodes.find((n) => n.id === leaf.id)).toBeUndefined();
  });

  it("the internal test mutations are not registered as public MCP tools", async () => {
    // Import the server registry surface and assert no tool name comes from
    // the test namespace. The registry lives inside McpServer; a lightweight
    // check is to search the built tool source for the mutation names.
    const files = [
      "server/documents.ts", "server/context.ts", "server/curriculum.ts",
      "server/generation.ts", "server/maths.ts", "server/index.ts",
    ];
    for (const f of files) {
      const text = readFileSync(resolve("src", f), "utf8");
      expect(text).not.toMatch(/test\/(setNodeProperty|deleteNode|validating)/);
      expect(text).not.toMatch(/runGraphMutation/);
    }
  });

  it("published reads stay unchanged after a draft-only mutation (parity oracle)", async () => {
    // Re-derive the parity oracle: default reads must match pre-mutation.
    async function reads(): Promise<unknown> {
      const state = newSessionState();
      return runInSession(state, async () => {
        const { activateContext } = await import("../activate.js");
        const r = await activateContext(firstCtx.grade, firstCtx.subject);
        if (!r.ok) throw new Error(r.error);
        const adapter = resolveAdapter(firstCtx.grade, firstCtx.subject)!;
        return {
          units: adapter.listUnits(),
          perScope: adapter.scopeValues().map((s) => ({ s, slice: adapter.slice(s), progression: adapter.progression(s) })),
        };
      });
    }
    const before = await reads();
    const graph = await readPublishedGraph(ns);
    const preview = await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: graph.nodes[0].id, key: "shouldNotLeak", value: "into-published" } });
    if (preview.phase !== "preview") throw new Error("preview");
    await runGraphMutation({ namespace: ns, mutation: setNodeProperty, args: { nodeId: graph.nodes[0].id, key: "shouldNotLeak", value: "into-published" }, confirm: true, token: preview.confirmationToken });
    const after = await reads();
    expect(after).toEqual(before);
  });
});

describe("shared confirm envelope — two lifecycles, stakes-accurate messaging", () => {
  it("document tools emit the shared envelope with LIVE-WRITE phrasing", () => {
    const env = buildConfirmEnvelope("write NOW to the bucket");
    expect(env).toMatchObject({ needsConfirmation: true, action: "write NOW to the bucket" });
    expect(env.message).toMatch(/confirm: true/);
    expect(env.action.toLowerCase()).toMatch(/writes now|write now/);
    // Explicitly does NOT carry the graph-only fields.
    expect("diff" in env).toBe(false);
    expect("confirmationToken" in env).toBe(false);
    expect("kind" in env).toBe(false);
  });

  it("graph previews carry the SAME shared common fields plus graph-only extensions", async () => {
    const before = await readPublishedGraph(ns);
    const preview = await runGraphMutation({
      namespace: ns, mutation: setNodeProperty,
      args: { nodeId: before.nodes[0].id, key: "k", value: 1 },
    });
    if (preview.phase !== "preview") throw new Error("preview");
    // Common shared fields exist and have the same names as the doc envelope.
    expect(typeof preview.needsConfirmation).toBe("boolean");
    expect(typeof preview.action).toBe("string");
    expect(typeof preview.message).toBe("string");
    // Extensions distinguish the graph lifecycle.
    expect(preview.kind).toBe("graphMutation");
    expect("diff" in preview).toBe(true);
    expect("confirmationToken" in preview).toBe(true);
    // Stakes differ from document tools.
    expect(preview.action.toLowerCase()).not.toMatch(/writes? now/);
    expect(preview.action.toLowerCase()).toMatch(/stages a draft edit/);
  });
});
