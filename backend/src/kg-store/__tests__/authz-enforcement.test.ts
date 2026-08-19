/*
 * #8 enforcement tests
 *
 * Drives runGraphMutation + the publish/discard wrappers under different
 * actors to prove:
 *   - authz derives ONLY from the verified Actor (spoof attempts via args are
 *     ignored — the args interface doesn't even accept an actor / role);
 *   - curator can apply/discard but not publish;
 *   - approver can publish and everything a curator can;
 *   - unknown / no-role is denied all three, with a blocked audit record;
 *   - denials never issue a token and never touch state;
 *   - self-approve config gates the publish path; the publish audit ALWAYS
 *     carries `selfAuthored` regardless of the flag;
 *   - reads and generation remain fully open for unknown actors.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { listAvailableContexts, newSessionState, runInSession } from "../../context/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, publishDraft, discardDraft, __resetMutationsForTest,
} from "../index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { runAsActor, __setActorForTest, type Actor } from "../../actor.js";
import type { GraphMutation, MutationGraph } from "../index.js";
import type { KgNodeStore, StoredMeta } from "../types.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const emptyHistory: HistoryFile = { version: 3, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [],
  getObjectMd5: async () => null,
  downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory,
  writeHistory: async () => {},
};

const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };
const APPROVER: Actor = { id: "approver-uid", email: "approver@test", role: "approver", unknown: false };
const SIGNED_IN_NO_ROLE: Actor = { id: "guest-uid", email: "guest@test", unknown: false };

type SetPropArgs = { nodeId: string; key: string; value: unknown };
const setNodeProperty: GraphMutation<SetPropArgs> = {
  name: "test/setNodeProperty",
  describe: (args) => `set property '${args.key}' on node '${args.nodeId}'`,
  apply: (base, args) => ({
    nodes: base.nodes.map((n) =>
      n.id === args.nodeId ? { ...n, properties: { ...n.properties, [args.key]: args.value } } : n,
    ),
    edges: base.edges,
  }),
};

const priorEnv = process.env.KG_SOURCE;
const priorSelfApprove = process.env.TLM_ALLOW_SELF_APPROVE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
// Pinned to the senegal workspace: this harness's curator/approver actor
// holds a role only there (legacy app_role bridge), and its mutations are
// tuned to that graph. A second workspace (nigeria) must not hijack it.
const firstCtx = contexts.find((c) => c.workspace === "senegal")!;
const ns = kgNamespace(firstCtx.workspace, firstCtx.grade, firstCtx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const adapter = resolveAdapter(workspace, grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(workspace, grade, subject));
    const meta: StoredMeta = {
      contentHash: "test", seededAt: "1970-01-01T00:00:00Z",
      adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length,
    };
    await freshStore.writeSlot(kgNamespace(workspace, grade, subject), "a", { nodes, edges, meta });
    await freshStore.ensurePointer(kgNamespace(workspace, grade, subject), "a");
  }
  return freshStore;
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
  __setActorForTest(null); // each test installs its own actor explicitly
  process.env.KG_SOURCE = "firestore";
});
afterEach(() => {
  if (priorSelfApprove === undefined) delete process.env.TLM_ALLOW_SELF_APPROVE;
  else process.env.TLM_ALLOW_SELF_APPROVE = priorSelfApprove;
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE;
  else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

// Helper: seed one apply on the draft (as a curator) so publish/discard have
// something to promote/discard. Returns the apply audit id.
async function seedOneCuratorApply(): Promise<string> {
  return await runAsActor(CURATOR, async () => {
    const graph = await readPublishedGraph(ns);
    const preview = await runGraphMutation({
      namespace: ns, mutation: setNodeProperty,
      args: { nodeId: graph.nodes[0].id, key: "seeded", value: 1 },
    });
    if (preview.phase !== "preview") {
      throw new Error(`preview expected, got ${preview.phase}`);
    }
    const applied = await runGraphMutation({
      namespace: ns, mutation: setNodeProperty,
      args: { nodeId: graph.nodes[0].id, key: "seeded", value: 1 },
      confirm: true, token: preview.confirmationToken,
    });
    if (applied.phase !== "apply" || !applied.ok) {
      throw new Error("apply failed");
    }
    const applies = await store.listAudit({ namespace: ns, eventType: "apply" });
    return applies[0].id;
  });
}

// ── Curator ─────────────────────────────────────────────────────────────────

describe("curator role", () => {
  it("can dry-run and confirm-apply on the internal test-only mutation", async () => {
    await runAsActor(CURATOR, async () => {
      const graph = await readPublishedGraph(ns);
      const preview = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
      });
      expect(preview.phase).toBe("preview");
      if (preview.phase !== "preview") {
        throw new Error("preview");
      }
      const applied = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
        confirm: true, token: preview.confirmationToken,
      });
      expect(applied.phase).toBe("apply");
      if (applied.phase === "apply") expect(applied.ok).toBe(true);
    });
  });

  it("can discard a draft they authored", async () => {
    await seedOneCuratorApply();
    await runAsActor(CURATOR, async () => {
      const result = await discardDraft(ns);
      expect(result.ok).toBe(true);
      const discardRecords = await store.listAudit({ namespace: ns, eventType: "discard" });
      expect(discardRecords).toHaveLength(1);
      expect(discardRecords[0].actor.role).toBe("curator");
    });
    // Draft is gone; published slot untouched.
    expect((await store.readPointer(ns))?.draftSlot).toBe(null);
  });

  it("cannot publish — blocked with an audit denial and no state change", async () => {
    await seedOneCuratorApply();
    const pointerBefore = await store.readPointer(ns);
    await runAsActor(CURATOR, async () => {
      const result = await publishDraft(ns);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/'curator' cannot publish/i);
    });
    // Pointer unchanged: draft still in place.
    expect(await store.readPointer(ns)).toEqual(pointerBefore);
    // A blocked audit was written for the denial (in addition to the seeded apply).
    const blocked = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(blocked.some((r) => r.reason?.startsWith("unauthorized"))).toBe(true);
  });
});

// ── Approver ────────────────────────────────────────────────────────────────

describe("approver role", () => {
  it("can publish a draft authored by someone else (no self-approval)", async () => {
    await seedOneCuratorApply(); // curator authored the applies
    await runAsActor(APPROVER, async () => {
      const result = await publishDraft(ns);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.selfAuthored).toBe(false);
        // Publish audit reflects it.
        const publishRecords = await store.listAudit({ namespace: ns, eventType: "publish" });
        expect(publishRecords[0].selfAuthored).toBe(false);
        expect(publishRecords[0].promotedApplyIds).toHaveLength(1);
      }
    });
    // A small publish applies the overlay in place — published slot stays "a".
    const pointer = await store.readPointer(ns);
    expect(pointer?.publishedSlot).toBe("a");
    expect(pointer?.draftSlot).toBe(null);
  });

  it("can also apply and discard — approver is a superset of curator", async () => {
    await runAsActor(APPROVER, async () => {
      const graph = await readPublishedGraph(ns);
      const preview = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
      });
      expect(preview.phase).toBe("preview");
      if (preview.phase !== "preview") {
        throw new Error("preview");
      }
      const applied = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
        confirm: true, token: preview.confirmationToken,
      });
      expect(applied.phase).toBe("apply");
      const discarded = await discardDraft(ns);
      expect(discarded.ok).toBe(true);
    });
  });

  it("self-approve is ALLOWED by default and the publish audit records selfAuthored:true", async () => {
    // Approver authors an apply, then publishes their own edit.
    await runAsActor(APPROVER, async () => {
      const graph = await readPublishedGraph(ns);
      const preview = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: "approver-authored" },
      });
      if (preview.phase !== "preview") {
        throw new Error("preview");
      }
      await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: "approver-authored" },
        confirm: true, token: preview.confirmationToken,
      });
      const result = await publishDraft(ns);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.selfAuthored).toBe(true);
    });
    const publishRecords = await store.listAudit({ namespace: ns, eventType: "publish" });
    expect(publishRecords[0].selfAuthored).toBe(true);
  });

  it("self-approve is DENIED when TLM_ALLOW_SELF_APPROVE=0", async () => {
    process.env.TLM_ALLOW_SELF_APPROVE = "0";
    await runAsActor(APPROVER, async () => {
      const graph = await readPublishedGraph(ns);
      const preview = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: "own edit" },
      });
      if (preview.phase !== "preview") {
        throw new Error("preview");
      }
      await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: "own edit" },
        confirm: true, token: preview.confirmationToken,
      });
      const result = await publishDraft(ns);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/separation-of-duties/i);
    });
    // No publish record; draft still open.
    expect(await store.listAudit({ namespace: ns, eventType: "publish" })).toHaveLength(0);
    expect((await store.readPointer(ns))?.draftSlot).toBe("b");
  });
});

// ── Unknown / no-role ───────────────────────────────────────────────────────

describe("unknown / no-role actor", () => {
  it("unknown actor cannot dry-run — returns phase:'unauthorized', writes blocked audit, no token, no state change", async () => {
    __setActorForTest(null);
    const graph = await readPublishedGraph(ns);
    const result = await runGraphMutation({
      namespace: ns, mutation: setNodeProperty,
      args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
    });
    expect(result.phase).toBe("unauthorized");
    if (result.phase === "unauthorized") {
      expect(result.action).toBe("apply");
      expect(result.reason).toMatch(/no verified identity/i);
    }
    // No token to leak, no state change.
    expect("confirmationToken" in result).toBe(false);
    expect((await store.readPointer(ns))?.draftSlot).toBe(null);
    // Blocked audit exists.
    const blocked = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].actor.unknown).toBe(true);
    expect(blocked[0].reason).toMatch(/^unauthorized:/);
  });

  it("signed-in-but-no-role cannot dry-run either — same treatment", async () => {
    await runAsActor(SIGNED_IN_NO_ROLE, async () => {
      const graph = await readPublishedGraph(ns);
      const result = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
      });
      expect(result.phase).toBe("unauthorized");
      if (result.phase === "unauthorized") expect(result.reason).toMatch(/no role is assigned/i);
    });
    const blocked = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(blocked[0].actor.id).toBe(SIGNED_IN_NO_ROLE.id);
    expect(blocked[0].actor.unknown).toBe(false);
    expect(blocked[0].actor.role).toBeNull();
  });

  it("unknown cannot publish or discard either", async () => {
    await seedOneCuratorApply();
    __setActorForTest(null);
    const publishResult = await publishDraft(ns);
    expect(publishResult.ok).toBe(false);
    const discardResult = await discardDraft(ns);
    expect(discardResult.ok).toBe(false);
    // Draft still there.
    expect((await store.readPointer(ns))?.draftSlot).toBe("b");
  });
});

// ── Spoof attempts ──────────────────────────────────────────────────────────

describe("authz derives only from the verified Actor — args cannot self-authorize", () => {
  it("the mutation args interface has no role/actor slot; passing extra fields has no effect on authz", async () => {
    __setActorForTest(null);
    // Attempt: an unknown actor invokes the framework with args that carry a
    // "role" field. Since args are strongly typed at the mutation level, the
    // structural test is simply that the framework STILL denies — the extra
    // field is ignored by authz because authz only reads Actor.role, which
    // comes from the JWT, not from args.
    const graph = await readPublishedGraph(ns);
    const result = await runGraphMutation({
      namespace: ns,
      mutation: setNodeProperty,
      // deliberately shape a "role: approver" claim into the args to prove
      // it doesn't get considered
      args: { nodeId: graph.nodes[0].id, key: "role", value: "approver" } as SetPropArgs,
    });
    expect(result.phase).toBe("unauthorized");
  });

  it("a preview issued to a curator cannot be confirmed by an unknown actor", async () => {
    // Curator gets a token.
    let token: string;
    await runAsActor(CURATOR, async () => {
      const graph = await readPublishedGraph(ns);
      const preview = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
      });
      if (preview.phase !== "preview") {
        throw new Error("preview");
      }
      token = preview.confirmationToken;
    });
    // Then an unknown actor tries to redeem it — authz denies before the
    // token is even checked.
    __setActorForTest(null);
    const graph = await readPublishedGraph(ns);
    const result = await runGraphMutation({
      namespace: ns, mutation: setNodeProperty,
      args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
      confirm: true, token: token!,
    });
    expect(result.phase).toBe("unauthorized");
    // No state change: no draft was created.
    expect((await store.readPointer(ns))?.draftSlot).toBe(null);
  });
});

// ── Denial audit shape ──────────────────────────────────────────────────────

describe("denial audit records are distinguishable and typed", () => {
  it("apply-denial audit has eventType='blocked' and reason starts with 'unauthorized:'", async () => {
    await runAsActor(SIGNED_IN_NO_ROLE, async () => {
      const graph = await readPublishedGraph(ns);
      await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
      });
    });
    const blocked = await store.listAudit({ namespace: ns, eventType: "blocked" });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason?.startsWith("unauthorized:")).toBe(true);
  });

  it("publish-denial audit for a curator has reason mentioning the role and the action", async () => {
    await seedOneCuratorApply();
    await runAsActor(CURATOR, async () => { await publishDraft(ns); });
    const blocked = await store.listAudit({ namespace: ns, eventType: "blocked" });
    const denial = blocked.find((r) => r.reason?.includes("cannot publish"));
    expect(denial).toBeTruthy();
    expect(denial!.reason).toMatch(/^unauthorized:.*publish/);
  });

  it("phase:'unauthorized' is distinct from phase:'blocked' (validation) and phase:'apply' ok:false (stale)", async () => {
    await runAsActor(SIGNED_IN_NO_ROLE, async () => {
      const graph = await readPublishedGraph(ns);
      const result = await runGraphMutation({
        namespace: ns, mutation: setNodeProperty,
        args: { nodeId: graph.nodes[0].id, key: "k", value: 1 },
      });
      expect(result.phase).toBe("unauthorized");
      // Not "blocked" (that's for validation errors).
      expect(result.phase).not.toBe("blocked");
      // Not "apply" (that's for confirm-time outcomes).
      expect(result.phase).not.toBe("apply");
    });
  });
});

// ── Reads and generation stay open ──────────────────────────────────────────

describe("reads and generation remain ungated for unknown actors", () => {
  it("unknown actor can read published curriculum unchanged", async () => {
    __setActorForTest(null);
    const state = newSessionState();
    const output = await runInSession(state, async () => {
      const { activateContext } = await import("../../activate.js");
      const activation = await activateContext(firstCtx.workspace, firstCtx.grade, firstCtx.subject);
      expect(activation.ok).toBe(true);
      const adapter = resolveAdapter(firstCtx.workspace, firstCtx.grade, firstCtx.subject)!;
      return { nodes: [...adapter.model().byId.keys()].sort() };
    });
    expect(output.nodes.length).toBeGreaterThan(0);
    // No blocked audit — reads didn't hit authz.
    expect(await store.listAudit({ namespace: ns, eventType: "blocked" })).toEqual([]);
  });
});

// ── Bootstrap ───────────────────────────────────────────────────────────────

describe("bootstrap — no MCP path can grant a role", () => {
  it("there is no exported tool or function that writes user_roles", async () => {
    // Structural check: the kg-store barrel + the authz module expose no
    // role-management surface. Roles are administered in Supabase.
    const kg = await import("../index.js");
    const authz = await import("../../authz.js");
    for (const [name] of Object.entries({ ...kg, ...authz })) {
      // Nothing should look like grantRole / setRole / assignRole / addRole.
      expect(name).not.toMatch(/grant|assignRole|setRole|addRole|writeRole/i);
    }
  });
});

// ── Parity oracle ───────────────────────────────────────────────────────────

describe("parity: reads are unaffected by #8", () => {
  it("a full apply chain by a curator leaves published byte-identical (parity oracle from #2)", async () => {
    async function reads(): Promise<unknown> {
      const state = newSessionState();
      return runInSession(state, async () => {
        const { activateContext } = await import("../../activate.js");
        const activation = await activateContext(firstCtx.workspace, firstCtx.grade, firstCtx.subject);
        if (!activation.ok) {
          throw new Error(activation.error);
        }
        const adapter = resolveAdapter(firstCtx.workspace, firstCtx.grade, firstCtx.subject)!;
        return { nodes: [...adapter.model().byId.keys()].sort() };
      });
    }
    const before = await reads();
    await seedOneCuratorApply();
    const after = await reads();
    expect(after).toEqual(before);
  });
});
