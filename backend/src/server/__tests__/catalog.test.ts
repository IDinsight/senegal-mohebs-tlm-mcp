// ── routine catalog — end to end on the CI-maths seed + a seeded catalog ────────
// Covers the store-backed path the tools drive: readCatalogGraph over a seeded
// catalog namespace, listCatalogEntries over it, and use_routine's two-phase copy
// (dry-run mints the id-map + stages nothing; confirm reuses the map and lands the
// cloned subtree + a usesRoutine edge on the DRAFT, published untouched).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { listAvailableContexts } from "../../context/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel, toRawEnvelope } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace, runGraphMutation, mintNodeId,
  edgeId as makeEdgeId, __resetMutationsForTest, __resetDraftTokensForTest,
} from "../../kg-store/index.js";
import type { MutationGraph, StoredMeta, KgNodeStore, StoredNode, StoredEdge } from "../../kg-store/index.js";
import { SHARED_CATALOG_NAMESPACE, catalogNamespace, cloneRoutineSubtree, listCatalogEntries, renderCatalogEntry, useRoutine } from "../../kg-recipes/index.js";
import { readCatalog } from "../catalog.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import type { StorageAdapter, HistoryFile, CurriculumModel } from "../../types.js";

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
const ns = kgNamespace("ci", "maths");
const adapter = () => resolveAdapter("ci", "maths")!;

// A catalog fixture in store shape (non-spine: LC props under properties.raw):
// root ─hasPart→ entry ─hasPart→ {s1 ─hasPart→ m1, s2 ─hasPart→ m2}.
const rNode = (id: string, label: string, raw: Record<string, unknown>): Omit<StoredNode, "slot"> =>
  ({ id, type: label, namespace: SHARED_CATALOG_NAMESPACE, labels: [label], spine: false, properties: { raw } });
const rEdge = (from: string, to: string): Omit<StoredEdge, "slot"> =>
  ({ id: makeEdgeId("hasPart", from, to), type: "hasPart", from, to, namespace: SHARED_CATALOG_NAMESPACE, properties: {} });

async function seedCatalog(s: KgNodeStore) {
  const nodes = [
    rNode("cat-root", "InstructionalRoutine", { description: "Catalog library" }),
    // a routine entry (steps → materials)…
    rNode("cat-entry", "InstructionalRoutine", { description: "Fiche de leçon", metadata: { summary: "French only" } }),
    rNode("cat-s1", "InstructionalRoutine", { description: "Déclencheur", position: 1, timeRequired: "PT4M" }),
    rNode("cat-s2", "InstructionalRoutine", { description: "Modelage", position: 2, timeRequired: "PT8M" }),
    rNode("cat-m1", "Material", { content: "..." }),
    rNode("cat-m2", "Material", { content: "..." }),
    // …a formatter entry (a spec Material, no steps)…
    rNode("cat-fmt", "InstructionalRoutine", { description: "House style", metadata: { catalogKind: "formatter" } }),
    rNode("cat-fmt-spec", "Material", { content: "palette + fonts + page setup" }),
    // …and a routine whose steps are DIRECT Material children — the shape produced by
    // authoring with add_nodes then promoting with add_to_catalog (no nested step-routines).
    rNode("cat-flat", "InstructionalRoutine", { description: "Séance d'intégration" }),
    rNode("cat-flat-1", "Material", { description: "Révision", position: 1, timeRequired: "PT5M", content: "corps révision" }),
    rNode("cat-flat-2", "Material", { description: "Intégration", position: 2, content: "corps intégration" }),
  ];
  const edges = [
    rEdge("cat-root", "cat-entry"), rEdge("cat-entry", "cat-s1"), rEdge("cat-entry", "cat-s2"), rEdge("cat-s1", "cat-m1"), rEdge("cat-s2", "cat-m2"),
    rEdge("cat-root", "cat-fmt"), rEdge("cat-fmt", "cat-fmt-spec"),
    rEdge("cat-root", "cat-flat"), rEdge("cat-flat", "cat-flat-1"), rEdge("cat-flat", "cat-flat-2"),
  ];
  const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: "catalog", nodeCount: nodes.length, edgeCount: edges.length };
  await s.writeSlot(SHARED_CATALOG_NAMESPACE, "a", { nodes, edges, meta });
  await s.ensurePointer(SHARED_CATALOG_NAMESPACE, "a");
}

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { workspace, grade, subject } of listAvailableContexts()) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const a = resolveAdapter(grade, subject);
    if (!a) continue;
    const { nodes, edges } = serializeModel(a.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: a.id, nodeCount: nodes.length, edgeCount: edges.length };
    await s.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(grade, subject), "a");
  }
  await seedCatalog(s);
  return s;
}

const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
async function readSlot(slot: "a" | "b"): Promise<MutationGraph> {
  const [nodes, edges] = await Promise.all([store.listNodes(ns, slot), store.listEdges(ns, slot)]);
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}
async function readPublished(): Promise<MutationGraph> { const p = await store.readPointer(ns); return readSlot(p!.publishedSlot); }
async function readDraft(): Promise<MutationGraph | null> { const p = await store.readPointer(ns); return p?.draftSlot ? readSlot(p.draftSlot) : null; }
const modelOf = (g: MutationGraph): CurriculumModel => adapter().parse(toRawEnvelope({ nodes: g.nodes, edges: g.edges }));

// A real Lesson id from the published CI-maths seed (a valid usesRoutine target).
function someLessonId(g: MutationGraph): string {
  const m = modelOf(g);
  const week = m.unitsOfKind("Semaine").find((w) => m.childrenOf(w.id).some((c) => c.kind === "Lesson"))!;
  return m.childrenOf(week.id).find((c) => c.kind === "Lesson")!.id;
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

describe("list_catalog", () => {
  it("reads the shared catalog and lists both kinds, tagged shared", async () => {
    const byId = Object.fromEntries(listCatalogEntries(await readCatalog(SHARED_CATALOG_NAMESPACE), "shared").map((e) => [e.id, e]));
    expect(byId["cat-entry"]).toMatchObject({ scope: "shared", kind: "routine", name: "Fiche de leçon", materialCount: 2 });
    expect(byId["cat-entry"].steps.map((s) => s.id)).toEqual(["cat-s1", "cat-s2"]);
    expect(byId["cat-fmt"]).toMatchObject({ scope: "shared", kind: "formatter", name: "House style", materialCount: 1 });
    expect(byId["cat-fmt"].steps).toEqual([]);   // a formatter has no ordered steps
  });

  it("derives steps from a routine's DIRECT Material children (the add_to_catalog shape)", async () => {
    const byId = Object.fromEntries(listCatalogEntries(await readCatalog(SHARED_CATALOG_NAMESPACE), "shared").map((e) => [e.id, e]));
    // The flat routine's step summary is populated from its Material children (name +
    // order + timing), matching what nested step-routines yield — not left empty.
    expect(byId["cat-flat"]).toMatchObject({ kind: "routine", materialCount: 2 });
    expect(byId["cat-flat"].steps).toEqual([
      { id: "cat-flat-1", name: "Révision", order: 1, timeRequired: "PT5M" },
      { id: "cat-flat-2", name: "Intégration", order: 2, timeRequired: undefined },
    ]);
    // A formatter's direct Materials stay spec, NOT steps (no regression).
    expect(byId["cat-fmt"].steps).toEqual([]);
  });

  it("reads a WORKSPACE-scoped catalog namespace independently, tagged workspace", async () => {
    // A second library living under a real workspace, separate from the shared one.
    const wsNs = catalogNamespace("senegal");
    const wsNode = (id: string, label: string, raw: Record<string, unknown>): Omit<StoredNode, "slot"> =>
      ({ id, type: label, namespace: wsNs, labels: [label], spine: false, properties: { raw } });
    const wsEdge = (from: string, to: string): Omit<StoredEdge, "slot"> =>
      ({ id: makeEdgeId("hasPart", from, to), type: "hasPart", from, to, namespace: wsNs, properties: {} });
    const nodes = [wsNode("ws-root", "InstructionalRoutine", { description: "Senegal library" }), wsNode("ws-entry", "InstructionalRoutine", { description: "Bilingual session" })];
    const edges = [wsEdge("ws-root", "ws-entry")];
    await store.writeSlot(wsNs, "a", { nodes, edges, meta: { contentHash: "t", seededAt: "1970-01-01T00:00:00Z", adapterId: "catalog", nodeCount: 2, edgeCount: 1 } });
    await store.ensurePointer(wsNs, "a");

    const entries = listCatalogEntries(await readCatalog(wsNs), "workspace");
    expect(entries.map((e) => e.id)).toEqual(["ws-entry"]);
    expect(entries[0].scope).toBe("workspace");
    // The shared library is untouched by the workspace one — separate namespaces.
    expect((await readCatalog(SHARED_CATALOG_NAMESPACE)).nodes.some((n) => n.id === "ws-entry")).toBe(false);
  });
});

describe("catalog browse resources", () => {
  it("renders an entry's FULL spec from the store (what the resource read serves)", async () => {
    const catalog = await readCatalog(SHARED_CATALOG_NAMESPACE);
    // A routine entry: heading + ordered, timed steps.
    const routineMd = renderCatalogEntry(catalog, "cat-entry", "shared")!;
    expect(routineMd).toContain("# Fiche de leçon");
    expect(routineMd).toContain("## Déclencheur  (PT4M)");
    // A formatter entry: its spec Material content — the load-bearing text
    // list_catalog only COUNTS, but the browse resource surfaces in full.
    const fmtMd = renderCatalogEntry(catalog, "cat-fmt", "shared")!;
    expect(fmtMd).toContain("# House style");
    expect(fmtMd).toContain("palette + fonts + page setup");
    // A routine with DIRECT Material steps renders each body UNDER its step heading
    // (with timing when present), in order — not as headingless spec text.
    const flatMd = renderCatalogEntry(catalog, "cat-flat", "shared")!;
    expect(flatMd).toContain("## Révision  (PT5M)");
    expect(flatMd).toContain("corps révision");
    expect(flatMd).toContain("## Intégration");
    expect(flatMd.indexOf("## Révision")).toBeLessThan(flatMd.indexOf("## Intégration")); // ordered
  });
});

describe("use_routine", () => {
  it("copies the entry onto a lesson: dry-run stages nothing; confirm lands the clone on the draft", async () => {
    const published = await readPublished();
    const lessonId = someLessonId(published);
    const catalog = await readCatalog(SHARED_CATALOG_NAMESPACE);

    // Dry-run: mint the id-map (as the tool does on the first call).
    const clone = cloneRoutineSubtree(catalog, "cat-entry", ns, () => mintNodeId())!;
    const args = { namespace: ns, targetId: lessonId, clonedNodes: clone.nodes, clonedEdges: clone.edges, newEntryId: clone.newEntryId };
    const preview = await runGraphMutation({ namespace: ns, mutation: useRoutine, args });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    expect(preview.diff.edges.added.map((e) => e.id)).toContain(makeEdgeId("usesRoutine", lessonId, clone.newEntryId));
    expect(preview.diff.nodes.added.map((n) => n.id).sort()).toEqual([...clone.nodes.map((n) => n.id)].sort());
    expect(await readDraft()).toBeNull();

    // Confirm: rebuild the identical clone from the returned id-map (as the tool does).
    const clone2 = cloneRoutineSubtree(catalog, "cat-entry", ns, (old) => clone.idMap[old])!;
    const args2 = { namespace: ns, targetId: lessonId, clonedNodes: clone2.nodes, clonedEdges: clone2.edges, newEntryId: clone2.newEntryId };
    const confirm = await runGraphMutation({ namespace: ns, mutation: useRoutine, args: args2, confirm: true, token: preview.confirmationToken });
    expect(confirm.phase).toBe("apply");

    const draft = (await readDraft())!;
    expect(draft.nodes.some((n) => n.id === clone.newEntryId && (n.labels ?? []).includes("InstructionalRoutine"))).toBe(true);
    expect(draft.edges.some((e) => e.id === makeEdgeId("usesRoutine", lessonId, clone.newEntryId))).toBe(true);
    // The whole subtree came along (entry + 2 steps + 2 materials = 5 nodes).
    expect(clone.nodes.every((n) => draft.nodes.some((d) => d.id === n.id))).toBe(true);
    // Isolated: published never saw the copy, and the draft still re-parses.
    expect((await readPublished()).nodes.some((n) => n.id === clone.newEntryId)).toBe(false);
    expect(() => modelOf(draft)).not.toThrow();
  });

  it("blocks copying onto a non-lesson target (a chapter grouping)", async () => {
    const published = await readPublished();
    const chapterId = modelOf(published).unitsOfKind("Chapitre")[0].id;
    const catalog = await readCatalog(SHARED_CATALOG_NAMESPACE);
    const clone = cloneRoutineSubtree(catalog, "cat-entry", ns, () => mintNodeId())!;
    const args = { namespace: ns, targetId: chapterId, clonedNodes: clone.nodes, clonedEdges: clone.edges, newEntryId: clone.newEntryId };
    const res = await runGraphMutation({ namespace: ns, mutation: useRoutine, args });
    expect(res.phase).toBe("blocked");
  });
});

describe("use_formatter", () => {
  it("copies a formatter onto a Course (deliverable root) and links it via usesRoutine", async () => {
    const published = await readPublished();
    const courseId = published.nodes.find((n) => (n.labels ?? []).includes("Course"))!.id;   // a deliverable root
    const catalog = await readCatalog(SHARED_CATALOG_NAMESPACE);

    const clone = cloneRoutineSubtree(catalog, "cat-fmt", ns, () => mintNodeId())!;
    const args = { namespace: ns, targetId: courseId, clonedNodes: clone.nodes, clonedEdges: clone.edges, newEntryId: clone.newEntryId };
    const preview = await runGraphMutation({ namespace: ns, mutation: useRoutine, args });
    if (preview.phase !== "preview") throw new Error(`expected preview, got ${preview.phase}`);
    expect(preview.diff.edges.added.map((e) => e.id)).toContain(makeEdgeId("usesRoutine", courseId, clone.newEntryId));

    const confirm = await runGraphMutation({ namespace: ns, mutation: useRoutine, args, confirm: true, token: preview.confirmationToken });
    expect(confirm.phase).toBe("apply");
    const draft = (await readDraft())!;
    // The formatter's spec Material came along, linked to the Course.
    expect(draft.nodes.some((n) => n.id === clone.newEntryId)).toBe(true);
    expect(draft.edges.some((e) => e.id === makeEdgeId("usesRoutine", courseId, clone.newEntryId))).toBe(true);
    expect((await readPublished()).edges.some((e) => e.id === makeEdgeId("usesRoutine", courseId, clone.newEntryId))).toBe(false);
  });
});
