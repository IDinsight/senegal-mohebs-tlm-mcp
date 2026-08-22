// ── the `catalog` redirect on the generic write verbs ──────────────────────────
// edit_node / add_nodes / create_edges normally write to the active subject's
// namespace. With `catalog` they write to a catalog LIBRARY instead, so a master
// entry that drifted from the copies use_formatter made can be corrected in place
// (before this, a stale "[p X]" in one spec meant re-filing a whole new entry).
// Covers the routing itself, the publish-on-confirm lifecycle (catalogs have no
// publish_draft), the destination gate, and the rollback when publishing is refused.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { listAvailableContexts, newSessionState, runInSession } from "../../context/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  edgeId as makeEdgeId, __resetMutationsForTest, __resetDraftTokensForTest,
} from "../../kg-store/index.js";
import { SHARED_CATALOG_NAMESPACE, catalogNamespace, listCatalogEntries } from "../../kg-recipes/index.js";
import { readCatalog } from "../catalog.js";
import { runAddNodes } from "../authoring.js";
import { runCreateEdges } from "../structural.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import { __setWorkspaceStoreForTest, createMemoryWorkspaceStore } from "../../workspaces/index.js";
import { activateContext } from "../../activate.js";
import { runGraphMutation } from "../../kg-store/index.js";
import { editNode } from "../../kg-recipes/index.js";
import { runCatalogWrite, type WriteOutcome } from "../catalog-target.js";
import type { StoredMeta, KgNodeStore, StoredNode, StoredEdge } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const emptyHistory: HistoryFile = { version: 3, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [], getObjectMd5: async () => null, downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory, writeHistory: async () => {},
};

const SUPER: Actor = { id: "super-uid", email: "super@test", superAdmin: true, unknown: false };
const APPROVER: Actor = { id: "appr-uid", email: "appr@test", role: "approver", unknown: false };
const CURATOR: Actor = { id: "cur-uid", email: "cur@test", role: "curator", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const subjectNs = kgNamespace(targetCtx.grade, targetCtx.subject);   // senegal/ci/maths
const wsCatalogNs = catalogNamespace("senegal");
const SHARED_ENTRY = "shared-root-e1";

// Seed a minimal catalog: a root container plus one InstructionalRoutine entry
// filed under it — the shape listCatalogEntries reads.
async function seedCatalog(s: KgNodeStore, namespace: string, rootId: string, withEntry: boolean) {
  const node = (id: string, raw: Record<string, unknown>): Omit<StoredNode, "slot"> =>
    ({ id, type: "InstructionalRoutine", namespace, labels: ["InstructionalRoutine"], spine: false, properties: { raw } });
  const edge = (from: string, to: string): Omit<StoredEdge, "slot"> =>
    ({ id: makeEdgeId("hasPart", from, to), type: "hasPart", from, to, namespace, properties: {} });
  const nodes = [node(rootId, { description: "Library" })];
  const edges: Array<Omit<StoredEdge, "slot">> = [];
  if (withEntry) {
    nodes.push(node(SHARED_ENTRY, { description: "Entrée existante" }));
    edges.push(edge(rootId, SHARED_ENTRY));
  }
  const meta: StoredMeta = { contentHash: "t", seededAt: "1970-01-01T00:00:00Z", adapterId: "catalog", nodeCount: nodes.length, edgeCount: edges.length };
  await s.writeSlot(namespace, "a", { nodes, edges, meta });
  await s.ensurePointer(namespace, "a");
}

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const adapter = resolveAdapter(workspace, grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await s.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(grade, subject), "a");
  }
  await seedCatalog(s, SHARED_CATALOG_NAMESPACE, "shared-root", true);
  await seedCatalog(s, wsCatalogNs, "senegal-root", false);
  return s;
}

// Run `fn` inside a session with `actor` active on CI-maths (what the tools need).
async function inCtx(actor: Actor, fn: () => Promise<void>): Promise<void> {
  await runInSession(newSessionState(), async () => {
    __setActorForTest(actor);
    const activated = await activateContext(targetCtx.workspace, targetCtx.grade, targetCtx.subject);
    if (!activated.ok) throw new Error(`activate: ${activated.error}`);
    await fn();
  });
}

// edit_node's tool body is registered inline on the MCP server, so drive the same
// two pieces it composes: the editNode mutation, routed by runCatalogWrite.
function runEditNode(a: { nodeId: string; title?: string; content?: string; catalog?: string; confirm?: boolean; confirmationToken?: string }): Promise<WriteOutcome> {
  const editInNamespace = async (namespace: string): Promise<WriteOutcome> => {
    const result = await runGraphMutation({
      namespace, mutation: editNode,
      args: { namespace, nodeId: a.nodeId, title: a.title, content: a.content },
      confirm: a.confirm, token: a.confirmationToken, storePayload: true,
    });
    return result as WriteOutcome;
  };
  return runCatalogWrite(a.catalog!, a.confirm, editInNamespace);
}

const sharedEntryName = async (): Promise<string | undefined> =>
  listCatalogEntries(await readCatalog(SHARED_CATALOG_NAMESPACE), "shared").find((e) => e.id === SHARED_ENTRY)?.name;

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __setWorkspaceStoreForTest(createMemoryWorkspaceStore({
    workspaces: [{ id: "senegal", displayName: "Senegal", createdBy: "seed", createdAt: "1970-01-01T00:00:00Z" }],
  }));
  __resetMutationsForTest();
  __resetDraftTokensForTest();
  __setActorForTest(SUPER);
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE; else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
  __setWorkspaceStoreForTest(null);
});

describe("edit_node with `catalog` — fixing a stale master entry", () => {
  it("renames a shared-library entry and publishes it live on confirm", async () => {
    await inCtx(SUPER, async () => {
      const dry = await runEditNode({ nodeId: SHARED_ENTRY, title: "Entrée corrigée", catalog: "shared" });
      expect(dry.publishesOnConfirm).toBe(true);
      expect(dry.confirmationToken).toBeTruthy();

      const done = await runEditNode({ nodeId: SHARED_ENTRY, title: "Entrée corrigée", catalog: "shared", confirm: true, confirmationToken: dry.confirmationToken as string });
      expect(done).toMatchObject({ ok: true, published: true });
      expect(done.catalog).toMatchObject({ scope: "shared", namespace: SHARED_CATALOG_NAMESPACE });
    });

    expect(await sharedEntryName()).toBe("Entrée corrigée");
    // Published, not stranded: the library has no draft left open.
    expect((await store.readPointer(SHARED_CATALOG_NAMESPACE))!.draftSlot).toBeFalsy();
  });

  it("stages nothing on a dry-run", async () => {
    await inCtx(SUPER, async () => {
      await runEditNode({ nodeId: SHARED_ENTRY, title: "Jamais appliqué", catalog: "shared" });
    });
    expect(await sharedEntryName()).toBe("Entrée existante");
    expect((await store.readPointer(SHARED_CATALOG_NAMESPACE))!.draftSlot).toBeFalsy();
  });

  it("leaves the ACTIVE SUBJECT graph alone — the redirect is total", async () => {
    const before = (await store.listNodes(subjectNs, "a")).length;
    await inCtx(SUPER, async () => {
      const dry = await runEditNode({ nodeId: SHARED_ENTRY, title: "Ailleurs", catalog: "shared" });
      await runEditNode({ nodeId: SHARED_ENTRY, title: "Ailleurs", catalog: "shared", confirm: true, confirmationToken: dry.confirmationToken as string });
    });
    expect((await store.listNodes(subjectNs, "a")).length).toBe(before);
    expect((await store.readPointer(subjectNs))!.draftSlot).toBeFalsy();
  });
});

describe("add_nodes / create_edges with `catalog`", () => {
  it("adds a Material spec under an existing entry and publishes it", async () => {
    await inCtx(SUPER, async () => {
      const items = [{ kind: "Material", parentId: SHARED_ENTRY, description: "Règle de mise en page", properties: { content: "Numéroter chaque page." } }];
      const dry = await runAddNodes({ items, catalog: "shared" });
      expect(dry.publishesOnConfirm).toBe(true);

      const done = await runAddNodes({
        items, catalog: "shared", confirm: true,
        confirmationToken: dry.confirmationToken as string,
        mintedNodeIds: dry.mintedNodeIds as string[],
      });
      expect(done).toMatchObject({ ok: true, published: true });
    });

    const catalog = await readCatalog(SHARED_CATALOG_NAMESPACE);
    const added = catalog.nodes.find((n) => (n.properties.raw as Record<string, unknown>)?.description === "Règle de mise en page");
    expect(added).toBeTruthy();
    expect(catalog.edges.some((e) => e.type === "hasPart" && e.from === SHARED_ENTRY && e.to === added!.id)).toBe(true);
  });

  it("wires an edge inside the library and publishes it", async () => {
    await inCtx(SUPER, async () => {
      const edges = [{ edgeType: "relatesTo", fromId: SHARED_ENTRY, toId: "shared-root" }];
      const dry = await runCreateEdges({ edges, catalog: "shared" });
      expect(dry.publishesOnConfirm).toBe(true);

      const done = await runCreateEdges({ edges, catalog: "shared", confirm: true, confirmationToken: dry.confirmationToken as string });
      expect(done).toMatchObject({ ok: true, published: true });
    });

    const catalog = await readCatalog(SHARED_CATALOG_NAMESPACE);
    expect(catalog.edges.some((e) => e.type === "relatesTo" && e.from === SHARED_ENTRY && e.to === "shared-root")).toBe(true);
  });
});

describe("`catalog` destination gate", () => {
  it("refuses a non-super-admin who targets the shared library", async () => {
    await inCtx(APPROVER, async () => {
      const res = await runEditNode({ nodeId: SHARED_ENTRY, title: "Tentative", catalog: "shared" });
      expect(String(res.error)).toMatch(/super admin/i);
    });
    expect(await sharedEntryName()).toBe("Entrée existante");
  });

  it("refuses a catalog that was never seeded rather than bootstrapping one", async () => {
    await inCtx(SUPER, async () => {
      const res = await runEditNode({ nodeId: SHARED_ENTRY, title: "Nulle part", catalog: "inexistant" });
      expect(String(res.error)).toMatch(/not been seeded/i);
    });
  });

  it("rolls the draft back when a CURATOR confirms (the step publishes)", async () => {
    // The senegal library has no entry, so author one to have something to publish.
    await inCtx(SUPER, async () => {
      const items = [{ kind: "Material", parentId: "senegal-root", description: "Base" }];
      const dry = await runAddNodes({ items, catalog: "workspace" });
      await runAddNodes({ items, catalog: "workspace", confirm: true, confirmationToken: dry.confirmationToken as string, mintedNodeIds: dry.mintedNodeIds as string[] });
    });

    await inCtx(CURATOR, async () => {
      const items = [{ kind: "Material", parentId: "senegal-root", description: "Ajout curateur" }];
      const dry = await runAddNodes({ items, catalog: "workspace" });
      const done = await runAddNodes({ items, catalog: "workspace", confirm: true, confirmationToken: dry.confirmationToken as string, mintedNodeIds: dry.mintedNodeIds as string[] });
      expect(String(done.error)).toMatch(/publish|approver/i);
    });

    // Rolled back: the curator's node never landed, and no draft is stranded in a
    // namespace nobody can enter to finish or discard it.
    const catalog = await readCatalog(wsCatalogNs);
    expect(catalog.nodes.some((n) => (n.properties.raw as Record<string, unknown>)?.description === "Ajout curateur")).toBe(false);
    expect((await store.readPointer(wsCatalogNs))!.draftSlot).toBeFalsy();
  });
});
