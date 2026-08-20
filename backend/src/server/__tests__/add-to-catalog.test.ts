// ── add_to_catalog — publish an authored routine INTO a catalog ─────────────────
// The write inverse of use_routine, end to end: author a routine inline in the
// active CI-maths graph, then add_to_catalog clones it into a catalog library and
// PUBLISHES it in one gated step. Covers the addCatalogEntry mutation (files the
// clone under the library root), the super_admin catalog CHOICE, and the
// destination gate (super_admin → shared; a workspace approver → its own library;
// a curator is refused because the step publishes).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { listAvailableContexts, newSessionState, runInSession } from "../../context/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel, toRawEnvelope } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace, runGraphMutation, mintNodeId,
  edgeId as makeEdgeId, __resetMutationsForTest, __resetDraftTokensForTest,
} from "../../kg-store/index.js";
import {
  SHARED_CATALOG_NAMESPACE, catalogNamespace, cloneRoutineSubtree, addCatalogEntry,
  listCatalogEntries, addNode,
} from "../../kg-recipes/index.js";
import { runAddToCatalog, readCatalog } from "../catalog.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import { __setWorkspaceStoreForTest, createMemoryWorkspaceStore } from "../../workspaces/index.js";
import { activateContext } from "../../activate.js";
import type { MutationGraph, StoredMeta, KgNodeStore, StoredNode, StoredEdge } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile, CurriculumModel } from "../../types.js";

const emptyHistory: HistoryFile = { version: 3, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [], getObjectMd5: async () => null, downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory, writeHistory: async () => {},
};
// A cross-workspace super admin, a senegal-workspace approver, a senegal curator.
const SUPER: Actor = { id: "super-uid", email: "super@test", superAdmin: true, unknown: false };
const APPROVER: Actor = { id: "appr-uid", email: "appr@test", role: "approver", unknown: false };
const CURATOR: Actor = { id: "cur-uid", email: "cur@test", role: "curator", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const ns = kgNamespace(targetCtx.grade, targetCtx.subject);        // senegal/ci/maths (2-arg → DEFAULT_WORKSPACE)
const wsCatalogNs = catalogNamespace("senegal");                   // the senegal workspace library
const adapter = () => resolveAdapter("senegal", "ci", "maths")!;

// Seed a minimal catalog (a root container + optionally one entry) into `namespace`.
async function seedCatalog(s: KgNodeStore, namespace: string, rootId: string, withEntry: boolean) {
  const node = (id: string, raw: Record<string, unknown>): Omit<StoredNode, "slot"> =>
    ({ id, type: "InstructionalRoutine", namespace, labels: ["InstructionalRoutine"], spine: false, properties: { raw } });
  const edge = (from: string, to: string): Omit<StoredEdge, "slot"> =>
    ({ id: makeEdgeId("hasPart", from, to), type: "hasPart", from, to, namespace, properties: {} });
  const nodes = [node(rootId, { description: "Library" })];
  const edges: Array<Omit<StoredEdge, "slot">> = [];
  if (withEntry) { nodes.push(node(`${rootId}-e1`, { description: "Existing entry" })); edges.push(edge(rootId, `${rootId}-e1`)); }
  const meta: StoredMeta = { contentHash: "t", seededAt: "1970-01-01T00:00:00Z", adapterId: "catalog", nodeCount: nodes.length, edgeCount: edges.length };
  await s.writeSlot(namespace, "a", { nodes, edges, meta });
  await s.ensurePointer(namespace, "a");
}

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const a = resolveAdapter(workspace, grade, subject);
    if (!a) continue;
    const { nodes, edges } = serializeModel(a.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: a.id, nodeCount: nodes.length, edgeCount: edges.length };
    await s.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(grade, subject), "a");
  }
  await seedCatalog(s, SHARED_CATALOG_NAMESPACE, "shared-root", true);
  await seedCatalog(s, wsCatalogNs, "senegal-root", false);
  return s;
}

const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
async function readSlot(namespace: string, slot: "a" | "b"): Promise<MutationGraph> {
  const [nodes, edges] = await Promise.all([store.listNodes(namespace, slot), store.listEdges(namespace, slot)]);
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}
async function readPublished(namespace: string): Promise<MutationGraph> { const p = await store.readPointer(namespace); return readSlot(namespace, p!.publishedSlot); }
const modelOf = (g: MutationGraph): CurriculumModel => adapter().parse(toRawEnvelope({ nodes: g.nodes, edges: g.edges }));

// A real Lesson id from the published CI-maths seed (a valid usesRoutine target).
function someLessonId(g: MutationGraph): string {
  const m = modelOf(g);
  const week = m.unitsOfKind("Semaine").find((w) => m.childrenOf(w.id).some((c) => c.kind === "Lesson"))!;
  return m.childrenOf(week.id).find((c) => c.kind === "Lesson")!.id;
}

// Author an InstructionalRoutine on a lesson in the active CI-maths DRAFT (two-phase
// add_node via usesRoutine), returning its id — the entry add_to_catalog will lift.
async function authorRoutine(title: string): Promise<string> {
  const lessonId = someLessonId(await readPublished(ns));
  const routineId = mintNodeId();
  const args = { namespace: ns, parentId: lessonId, label: "InstructionalRoutine", newNodeId: routineId, title, via: "usesRoutine" };
  const preview = await runGraphMutation({ namespace: ns, mutation: addNode, args });
  if (preview.phase !== "preview") throw new Error(`author: ${preview.phase}`);
  const confirm = await runGraphMutation({ namespace: ns, mutation: addNode, args, confirm: true, token: preview.confirmationToken });
  if (confirm.phase !== "apply") throw new Error(`author confirm: ${confirm.phase}`);
  return routineId;
}

// Run `fn` inside a session with `actor` active on CI-maths (what the tools need).
async function inCtx(actor: Actor, fn: () => Promise<void>): Promise<void> {
  await runInSession(newSessionState(), async () => {
    __setActorForTest(actor);
    const act = await activateContext(targetCtx.workspace, targetCtx.grade, targetCtx.subject);
    if (!act.ok) throw new Error(`activate: ${act.error}`);
    await fn();
  });
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  // A memory workspace registry (one tenant) so the super_admin choice list is
  // populated without reaching live Firestore.
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

describe("addCatalogEntry mutation", () => {
  it("files a cloned entry under the catalog's root container", async () => {
    const catalog = await readCatalog(SHARED_CATALOG_NAMESPACE);
    const clone = cloneRoutineSubtree(catalog, "shared-root-e1", SHARED_CATALOG_NAMESPACE, () => mintNodeId())!;
    const preview = await runGraphMutation({
      namespace: SHARED_CATALOG_NAMESPACE, mutation: addCatalogEntry,
      args: { namespace: SHARED_CATALOG_NAMESPACE, clonedNodes: clone.nodes, clonedEdges: clone.edges, newEntryId: clone.newEntryId },
    });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    // The new entry is filed under the library root by hasPart.
    expect(preview.diff.edges.added.map((e) => e.id)).toContain(makeEdgeId("hasPart", "shared-root", clone.newEntryId));
    expect(preview.diff.nodes.added.map((n) => n.id)).toContain(clone.newEntryId);
  });
});

describe("add_to_catalog — super admin → shared library", () => {
  it("clones an authored routine into the shared catalog and publishes it live", async () => {
    await inCtx(SUPER, async () => {
      const routineId = await authorRoutine("Ma routine explicite");

      const dry = await runAddToCatalog({ entryId: routineId, targetWorkspace: "_shared" });
      expect(dry.publishesOnConfirm).toBe(true);
      expect(dry.confirmationToken).toBeTruthy();
      const mintedIdMap = dry.mintedIdMap as Record<string, string>;
      expect(mintedIdMap[routineId]).toBeTruthy();
      // Dry-run stages nothing: the shared catalog has no draft yet.
      expect((await store.readPointer(SHARED_CATALOG_NAMESPACE))!.draftSlot).toBeFalsy();

      const done = await runAddToCatalog({ entryId: routineId, targetWorkspace: "_shared", confirm: true, confirmationToken: dry.confirmationToken as string, mintedIdMap });
      expect(done).toMatchObject({ ok: true, published: true, scope: "shared" });
    });

    // Published live into the shared library, and browsable as an entry.
    const shared = await readCatalog(SHARED_CATALOG_NAMESPACE);
    expect(shared.nodes.some((n) => (n.properties.raw as Record<string, unknown>)?.description === "Ma routine explicite")).toBe(true);
    expect(listCatalogEntries(shared, "shared").some((e) => e.name === "Ma routine explicite")).toBe(true);
    // No leftover draft; the workspace library is untouched.
    expect((await store.readPointer(SHARED_CATALOG_NAMESPACE))!.draftSlot).toBeFalsy();
    expect(listCatalogEntries(await readCatalog(wsCatalogNs), "workspace").some((e) => e.name === "Ma routine explicite")).toBe(false);
  });

  it("offers the catalog choices when a super admin names no target", async () => {
    await inCtx(SUPER, async () => {
      const routineId = await authorRoutine("Peu importe");
      const res = await runAddToCatalog({ entryId: routineId });
      expect(res.needsChoice).toBe(true);
      const targets = (res.choices as Array<{ target: string }>).map((c) => c.target);
      expect(targets).toContain("_shared");
    });
  });
});

describe("add_to_catalog — destination gate", () => {
  it("refuses a non-super-admin who targets another catalog (the shared library)", async () => {
    await inCtx(APPROVER, async () => {
      const routineId = await authorRoutine("Tentative partagée");
      const res = await runAddToCatalog({ entryId: routineId, targetWorkspace: "_shared" });
      expect(String(res.error)).toMatch(/super admin/i);
    });
    // Nothing landed in the shared library.
    expect(listCatalogEntries(await readCatalog(SHARED_CATALOG_NAMESPACE), "shared").some((e) => e.name === "Tentative partagée")).toBe(false);
  });

  it("lets a workspace APPROVER publish into their own workspace library", async () => {
    await inCtx(APPROVER, async () => {
      const routineId = await authorRoutine("Routine senegal");
      const dry = await runAddToCatalog({ entryId: routineId });
      const done = await runAddToCatalog({ entryId: routineId, confirm: true, confirmationToken: dry.confirmationToken as string, mintedIdMap: dry.mintedIdMap as Record<string, string> });
      expect(done).toMatchObject({ ok: true, published: true, scope: "workspace" });
    });
    expect(listCatalogEntries(await readCatalog(wsCatalogNs), "workspace").some((e) => e.name === "Routine senegal")).toBe(true);
  });

  it("refuses a CURATOR (the step publishes) and rolls the catalog draft back", async () => {
    await inCtx(CURATOR, async () => {
      const routineId = await authorRoutine("Routine curateur");
      const dry = await runAddToCatalog({ entryId: routineId });
      const done = await runAddToCatalog({ entryId: routineId, confirm: true, confirmationToken: dry.confirmationToken as string, mintedIdMap: dry.mintedIdMap as Record<string, string> });
      expect(String(done.error)).toMatch(/publish|approver/i);
    });
    // Rolled back: no entry, and no stranded draft on the workspace library.
    expect(listCatalogEntries(await readCatalog(wsCatalogNs), "workspace").some((e) => e.name === "Routine curateur")).toBe(false);
    expect((await store.readPointer(wsCatalogNs))!.draftSlot).toBeFalsy();
  });
});

// The wrapper-park mechanism on the CATALOG surface: a large-enough cloned
// entry is parked at dry-run so add_to_catalog's confirm needs ONLY the token.
// Uses TLM_CONFIRM_STORE_BYTES to make even the tiny authored routine cross the
// threshold — the mechanism, not the specific size, is what we're asserting.
describe("token-only confirm — add_to_catalog wrapper parking", () => {
  const priorThreshold = process.env.TLM_CONFIRM_STORE_BYTES;
  beforeAll(() => { process.env.TLM_CONFIRM_STORE_BYTES = "1"; });   // park every payload
  afterAll(() => { if (priorThreshold === undefined) delete process.env.TLM_CONFIRM_STORE_BYTES; else process.env.TLM_CONFIRM_STORE_BYTES = priorThreshold; });

  it("clones + publishes token-only (no entryId / targetWorkspace / mintedIdMap on confirm)", async () => {
    await inCtx(SUPER, async () => {
      const routineId = await authorRoutine("Routine parquée");
      const dry = await runAddToCatalog({ entryId: routineId, targetWorkspace: "_shared" });
      expect(dry.payloadStored).toBe(true);
      // Confirm with ONLY confirm + token.
      const done = await runAddToCatalog({ confirm: true, confirmationToken: dry.confirmationToken as string });
      expect(done).toMatchObject({ ok: true, published: true, scope: "shared" });
    });
    expect(listCatalogEntries(await readCatalog(SHARED_CATALOG_NAMESPACE), "shared").some((e) => e.name === "Routine parquée")).toBe(true);
  });

  it("a stale token-only confirm (parked context missing) reports stale", async () => {
    await inCtx(SUPER, async () => {
      const routineId = await authorRoutine("Ephemère");
      const dry = await runAddToCatalog({ entryId: routineId, targetWorkspace: "_shared" });
      // Simulate the parked entry vanishing (TTL sweep / instance restart) before confirm.
      const nonce = (JSON.parse(Buffer.from(dry.confirmationToken as string, "base64url").toString("utf8")) as { n: string }).n;
      await store.deletePending(SHARED_CATALOG_NAMESPACE, `${nonce}:w`);
      const done = await runAddToCatalog({ confirm: true, confirmationToken: dry.confirmationToken as string });
      expect(done.ok).toBe(false);
      expect(String((done as { reason?: unknown }).reason)).toBe("stale");
    });
  });
});
