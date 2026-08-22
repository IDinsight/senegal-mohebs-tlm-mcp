// ── routine catalog — end to end on the CI-maths seed + a seeded catalog ────────
// Covers the store-backed path the tools drive: readCatalogGraph over a seeded
// catalog namespace, listCatalogEntries over it, and use_routine's two-phase copy
// (dry-run mints the id-map + stages nothing; confirm reuses the map and lands the
// cloned subtree + a usesRoutine edge on the DRAFT, published untouched).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { listAvailableContexts, newSessionState, runInSession } from "../../context/index.js";
import { activateContext } from "../../activate.js";
import { applyCatalogEntry } from "../catalog.js";
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
const adapter = () => resolveAdapter("senegal", "ci", "maths")!;

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
    // …and a RUBRIC entry — one level deeper than a formatter: weighted sections of
    // named criteria, each criterion's measurable indicator in its `content`.
    rNode("cat-rub", "InstructionalRoutine", { description: "Grille d'approbation", metadata: { catalogKind: "rubric", scale: "oui-non", summary: "Oui/Non, tout Non bloque" } }),
    rNode("cat-rub-a", "InstructionalRoutine", { description: "A. Contenus", position: 1, metadata: { weight: "20%" } }),
    rNode("cat-rub-a1", "Material", { description: "Exactitude", position: 1, content: "Les contenus sont-ils exacts ?" }),
    rNode("cat-rub-a2", "Material", { description: "Progression", position: 2, content: "La progression est-elle observable ?" }),
    rNode("cat-rub-b", "InstructionalRoutine", { description: "B. Genre", position: 2 }),
    rNode("cat-rub-b1", "Material", { description: "Équité", position: 1, content: "Les deux sexes sont-ils représentés équitablement ?" }),
  ];
  const edges = [
    rEdge("cat-root", "cat-entry"), rEdge("cat-entry", "cat-s1"), rEdge("cat-entry", "cat-s2"), rEdge("cat-s1", "cat-m1"), rEdge("cat-s2", "cat-m2"),
    rEdge("cat-root", "cat-fmt"), rEdge("cat-fmt", "cat-fmt-spec"),
    rEdge("cat-root", "cat-flat"), rEdge("cat-flat", "cat-flat-1"), rEdge("cat-flat", "cat-flat-2"),
    rEdge("cat-root", "cat-rub"), rEdge("cat-rub", "cat-rub-a"), rEdge("cat-rub", "cat-rub-b"),
    rEdge("cat-rub-a", "cat-rub-a1"), rEdge("cat-rub-a", "cat-rub-a2"), rEdge("cat-rub-b", "cat-rub-b1"),
  ];
  const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: "catalog", nodeCount: nodes.length, edgeCount: edges.length };
  await s.writeSlot(SHARED_CATALOG_NAMESPACE, "a", { nodes, edges, meta });
  await s.ensurePointer(SHARED_CATALOG_NAMESPACE, "a");
}

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { workspace, grade, subject } of listAvailableContexts()) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const a = resolveAdapter(workspace, grade, subject);
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

// Seed a TeachingLearningMaterial (+ covers→course) into the published slot so
// use_formatter has a document to resolve/attach under — the CI-maths fixture has
// none (the Phase 4 TLM migration hasn't run on it).
async function addTlmToPublished(courseId: string, tlmId = "tlm-fixture"): Promise<string> {
  const slot = (await store.readPointer(ns))!.publishedSlot;
  const [nodes, edges] = await Promise.all([store.listNodes(ns, slot), store.listEdges(ns, slot)]);
  const tlm: Omit<StoredNode, "slot"> = { id: tlmId, type: "TeachingLearningMaterial", namespace: ns, labels: ["TeachingLearningMaterial"], spine: false, properties: { raw: { description: "Manuel de l'élève", metadata: { role: "teaching-learning-material", assemblyGuide: "how to build me" } } } };
  const covers: Omit<StoredEdge, "slot"> = { id: makeEdgeId("covers", tlmId, courseId), type: "covers", from: tlmId, to: courseId, namespace: ns, properties: {} };
  const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: "test", nodeCount: nodes.length + 1, edgeCount: edges.length + 1 };
  await store.writeSlot(ns, slot, { nodes: [...nodes.map(strip), tlm], edges: [...edges.map(strip), covers], meta });
  return tlmId;
}

// Activate the ci/maths context inside a fresh session as the curator — the setup
// use_formatter's tool-layer resolution (getActiveAdapter / readActiveGraph) needs.
async function inCtx(fn: () => Promise<void>): Promise<void> {
  await runInSession(newSessionState(), async () => {
    __setActorForTest(CURATOR);
    const act = await activateContext("senegal", "ci", "maths");
    if (!act.ok) throw new Error(`activate: ${act.error}`);
    await fn();
  });
}

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

  it("lists a rubric's sections as steps, with their weights and criteria", async () => {
    const byId = Object.fromEntries(listCatalogEntries(await readCatalog(SHARED_CATALOG_NAMESPACE), "shared").map((e) => [e.id, e]));
    // materialCount counts the leaves under the whole entry — here the 3 criteria.
    expect(byId["cat-rub"]).toMatchObject({ kind: "rubric", scale: "oui-non", materialCount: 3 });
    // The criteria hang off SECTIONS, not off the entry, so they surface as each
    // section's `materials` (the entry's own `materials` stays empty).
    expect(byId["cat-rub"].steps).toEqual([
      { id: "cat-rub-a", name: "A. Contenus", order: 1, timeRequired: undefined, weight: "20%",
        materials: [{ id: "cat-rub-a1", name: "Exactitude" }, { id: "cat-rub-a2", name: "Progression" }] },
      { id: "cat-rub-b", name: "B. Genre", order: 2, timeRequired: undefined, weight: undefined,
        materials: [{ id: "cat-rub-b1", name: "Équité" }] },
    ]);
    // A routine still reports no scale — the field is the rubric's alone.
    expect(byId["cat-entry"].scale).toBeUndefined();
  });

  it("derives steps from a routine's DIRECT Material children (the add_to_catalog shape)", async () => {
    const byId = Object.fromEntries(listCatalogEntries(await readCatalog(SHARED_CATALOG_NAMESPACE), "shared").map((e) => [e.id, e]));
    // The flat routine's step summary is populated from its Material children (name +
    // order + timing), matching what nested step-routines yield — not left empty.
    expect(byId["cat-flat"]).toMatchObject({ kind: "routine", materialCount: 2 });
    expect(byId["cat-flat"].steps).toEqual([
      // `materials` is empty because a flat step HOLDS its text — the step id is
      // itself what edit_node takes, so there is no separate Material to name.
      { id: "cat-flat-1", name: "Révision", order: 1, timeRequired: "PT5M", materials: [] },
      { id: "cat-flat-2", name: "Intégration", order: 2, timeRequired: undefined, materials: [] },
    ]);
    // A formatter's direct Materials stay spec, NOT steps (no regression).
    expect(byId["cat-fmt"].steps).toEqual([]);
  });

  // A catalog is not walkable (walk_graph reads a parsed CurriculumModel and a
  // catalog has no subject profile), so these ids are the ONLY way to reach the
  // node holding a spec's text — without them a drifted master cannot be corrected.
  it("names the Material node ids under an entry, for both entry shapes", async () => {
    const byId = Object.fromEntries(listCatalogEntries(await readCatalog(SHARED_CATALOG_NAMESPACE), "shared").map((e) => [e.id, e]));

    // A FORMATTER's spec lives in its own direct Materials — the case that had no
    // id anywhere before (steps is [] for a formatter, so nothing surfaced it).
    expect(byId["cat-fmt"].materials.map((m) => m.id)).toEqual(["cat-fmt-spec"]);

    // A NESTED routine step's text sits in Material grandchildren, one id per step.
    expect(byId["cat-entry"].steps.map((s) => s.materials.map((m) => m.id))).toEqual([["cat-m1"], ["cat-m2"]]);
    // The entry itself has no direct Materials in the nested shape.
    expect(byId["cat-entry"].materials).toEqual([]);

    // A FLAT routine's Materials ARE its steps, and are listed both ways — the
    // field means "this entry's own Materials" regardless of kind.
    expect(byId["cat-flat"].materials.map((m) => m.id)).toEqual(["cat-flat-1", "cat-flat-2"]);

    // materialCount stays the count of the same leaves the ids now name.
    expect(byId["cat-entry"].materialCount).toBe(byId["cat-entry"].steps.flatMap((s) => s.materials).length);
    expect(byId["cat-fmt"].materialCount).toBe(byId["cat-fmt"].materials.length);
  });

  it("prints each spec's node id beside its content so it can be edited", async () => {
    const graph = await readCatalog(SHARED_CATALOG_NAMESPACE);

    // A formatter renders its spec flat, with no heading to identify it — the id
    // line is the only thing tying the text to an editable node.
    const formatter = renderCatalogEntry(graph, "cat-fmt", "shared")!;
    expect(formatter).toContain("`edit_node` nodeId: `cat-fmt-spec`");
    expect(formatter).toContain("palette + fonts + page setup");

    // A nested routine names the grandchild Material, not the step routine.
    const routine = renderCatalogEntry(graph, "cat-entry", "shared")!;
    expect(routine).toContain("`edit_node` nodeId: `cat-m1`");
    expect(routine).not.toContain("`edit_node` nodeId: `cat-s1`");

    // A flat routine's step IS the Material, so its own id is the one printed.
    const flat = renderCatalogEntry(graph, "cat-flat", "shared")!;
    expect(flat).toContain("`edit_node` nodeId: `cat-flat-1`");
    expect(flat).toContain("corps révision");
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

  it("renders a rubric as its scale plus weighted sections of named criteria", async () => {
    const md = renderCatalogEntry(await readCatalog(SHARED_CATALOG_NAMESPACE), "cat-rub", "shared")!;
    expect(md).toContain("*rubric · shared catalog*");
    expect(md).toContain("**Échelle : oui-non**");
    expect(md).toContain("## A. Contenus  (poids : 20%)");
    expect(md).toContain("## B. Genre");          // a section may carry no weight
    // A criterion has BOTH a name and an indicator, so unlike a routine step's body
    // the name gets its own heading — otherwise the grid reads as loose questions.
    expect(md).toContain("### Exactitude");
    expect(md).toContain("Les contenus sont-ils exacts ?");
    // …and each criterion names the node holding it, so a wrong indicator in a master
    // can be corrected with edit_node(nodeId, content, catalog).
    expect(md).toContain("`edit_node` nodeId: `cat-rub-a1`");
    expect(md.indexOf("### Exactitude")).toBeLessThan(md.indexOf("### Progression"));
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

// use_formatter is the document-side apply: a formatter hangs under the Course's
// TeachingLearningMaterial via hasPart (relabelled to Formatter/FormatterSpec), NOT
// on a Course via usesRoutine (the pre-Phase-4 stopgap). Driven through the exported
// applyCatalogEntry (behind the tool) inside an activated context, so the tool-layer
// TLM resolution runs.
describe("use_formatter", () => {
  const jsonOf = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

  it("resolves the Course's TLM and lands a Formatter under it via hasPart (re-send confirm)", async () => {
    await inCtx(async () => {
      const courseId = (await readPublished()).nodes.find((n) => (n.labels ?? []).includes("Course"))!.id;
      const tlmId = await addTlmToPublished(courseId);

      // Dry-run against the COURSE — use_formatter resolves it to the covering TLM.
      const dry = jsonOf(await applyCatalogEntry({ entryId: "cat-fmt", targetId: courseId }, "formatter")) as {
        diff: { edges: { added: Array<{ id: string }> } }; mintedIdMap: Record<string, string>; confirmationToken: string;
      };
      const newFmtId = dry.mintedIdMap["cat-fmt"];
      expect(dry.diff.edges.added.map((e) => e.id)).toContain(makeEdgeId("hasPart", tlmId, newFmtId));
      expect(await readDraft()).toBeNull();   // dry-run stages nothing

      // Confirm (small clone → not parked → re-send entryId/targetId/mintedIdMap).
      const done = jsonOf(await applyCatalogEntry({ entryId: "cat-fmt", targetId: courseId, mintedIdMap: dry.mintedIdMap, confirm: true, confirmationToken: dry.confirmationToken }, "formatter")) as { phase: string; ok: boolean };
      expect(done.phase).toBe("apply");
      expect(done.ok).toBe(true);

      const draft = (await readDraft())!;
      // The copy is relabelled to the document layer and hung under the TLM.
      expect(draft.nodes.find((n) => n.id === newFmtId)!.labels).toEqual(["Formatter"]);
      expect(draft.nodes.find((n) => n.id === dry.mintedIdMap["cat-fmt-spec"])!.labels).toEqual(["FormatterSpec"]);
      expect(draft.edges.some((e) => e.id === makeEdgeId("hasPart", tlmId, newFmtId))).toBe(true);
      // No usesRoutine edge onto the copy, and published never saw it.
      expect(draft.edges.some((e) => e.type === "usesRoutine" && e.to === newFmtId)).toBe(false);
      expect((await readPublished()).nodes.some((n) => n.id === newFmtId)).toBe(false);
    });
  });

  it("accepts a TLM id directly as the target", async () => {
    await inCtx(async () => {
      const courseId = (await readPublished()).nodes.find((n) => (n.labels ?? []).includes("Course"))!.id;
      const tlmId = await addTlmToPublished(courseId);
      const dry = jsonOf(await applyCatalogEntry({ entryId: "cat-fmt", targetId: tlmId }, "formatter")) as {
        diff: { edges: { added: Array<{ id: string }> } }; mintedIdMap: Record<string, string>;
      };
      expect(dry.diff.edges.added.map((e) => e.id)).toContain(makeEdgeId("hasPart", tlmId, dry.mintedIdMap["cat-fmt"]));
    });
  });

  it("errors when the target Course has no TLM to cover it yet", async () => {
    await inCtx(async () => {
      const courseId = (await readPublished()).nodes.find((n) => (n.labels ?? []).includes("Course"))!.id;
      const res = jsonOf(await applyCatalogEntry({ entryId: "cat-fmt", targetId: courseId }, "formatter")) as { error?: string };
      expect(res.error).toMatch(/no TeachingLearningMaterial covering it yet/);
    });
  });
});

describe("use_rubric", () => {
  const jsonOf = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

  it("relabels the copy across all THREE levels and hangs it under the document", async () => {
    await inCtx(async () => {
      const courseId = (await readPublished()).nodes.find((n) => (n.labels ?? []).includes("Course"))!.id;
      const tlmId = await addTlmToPublished(courseId);

      const dry = jsonOf(await applyCatalogEntry({ entryId: "cat-rub", targetId: courseId }, "rubric")) as {
        mintedIdMap: Record<string, string>; confirmationToken: string;
      };
      const done = jsonOf(await applyCatalogEntry({ entryId: "cat-rub", targetId: courseId, mintedIdMap: dry.mintedIdMap, confirm: true, confirmationToken: dry.confirmationToken }, "rubric")) as { ok: boolean };
      expect(done.ok).toBe(true);

      const draft = (await readDraft())!;
      const labelsOf = (oldId: string) => draft.nodes.find((n) => n.id === dry.mintedIdMap[oldId])!.labels;
      expect(labelsOf("cat-rub")).toEqual(["Rubric"]);
      expect(labelsOf("cat-rub-a")).toEqual(["RubricSection"]);
      expect(labelsOf("cat-rub-a1")).toEqual(["RubricCriterion"]);
      // The grid hangs off the DOCUMENT, like a formatter — never a usesRoutine edge.
      expect(draft.edges.some((e) => e.id === makeEdgeId("hasPart", tlmId, dry.mintedIdMap["cat-rub"]))).toBe(true);
      expect(draft.edges.some((e) => e.type === "usesRoutine" && e.to === dry.mintedIdMap["cat-rub"])).toBe(false);
      // Weight and scale are CONTENT, not kind tags — they survive the relabel, while
      // catalogKind (which the label now carries) is scrubbed.
      const rubric = draft.nodes.find((n) => n.id === dry.mintedIdMap["cat-rub"])!;
      const section = draft.nodes.find((n) => n.id === dry.mintedIdMap["cat-rub-a"])!;
      const meta = (n: typeof rubric) => ((n.properties!.raw as Record<string, unknown>).metadata ?? {}) as Record<string, unknown>;
      expect(meta(rubric).scale).toBe("oui-non");
      expect(meta(rubric).catalogKind).toBeUndefined();
      expect(meta(section).weight).toBe("20%");
    });
  });

  it("refuses a Lesson as the target — a grid judges the document, not the curriculum", async () => {
    await inCtx(async () => {
      const lessonId = someLessonId(await readPublished());
      const res = jsonOf(await applyCatalogEntry({ entryId: "cat-rub", targetId: lessonId }, "rubric")) as { error?: string };
      expect(res.error).toMatch(/use_rubric targets a TeachingLearningMaterial/);
    });
  });
});

// Wrapper-park mechanism on use_routine / use_formatter. TLM_CONFIRM_STORE_BYTES
// is dropped so even the small test-fixture entries cross the threshold — the
// mechanism, not the specific size, is what we're asserting. Drives the exported
// applyCatalogEntry (behind both tools) inside an activated context.
describe("token-only confirm — use_routine wrapper parking", () => {
  const priorThreshold = process.env.TLM_CONFIRM_STORE_BYTES;
  beforeAll(() => { process.env.TLM_CONFIRM_STORE_BYTES = "1"; });
  afterAll(() => { if (priorThreshold === undefined) delete process.env.TLM_CONFIRM_STORE_BYTES; else process.env.TLM_CONFIRM_STORE_BYTES = priorThreshold; });

  it("copies onto a lesson token-only (no entryId / targetId / mintedIdMap on confirm)", async () => {
    await inCtx(async () => {
      const lessonId = someLessonId(await readPublished());
      const dry = (await applyCatalogEntry({ entryId: "cat-entry", targetId: lessonId })) as { content?: Array<{ text: string }> };
      const dryJson = JSON.parse(dry.content![0].text) as { payloadStored?: boolean; confirmationToken?: string; mintedIdMap?: Record<string, string> };
      expect(dryJson.payloadStored).toBe(true);
      expect(dryJson.confirmationToken).toBeTruthy();
      // Confirm with ONLY confirm + token.
      const done = (await applyCatalogEntry({ confirm: true, confirmationToken: dryJson.confirmationToken })) as { content?: Array<{ text: string }> };
      const doneJson = JSON.parse(done.content![0].text) as { phase?: string; ok?: boolean };
      expect(doneJson.phase).toBe("apply");
      expect(doneJson.ok).toBe(true);
      // The clone landed on the draft (mirroring the re-send test above).
      const newEntryId = dryJson.mintedIdMap!["cat-entry"];
      const draft = (await readDraft())!;
      expect(draft.edges.some((e) => e.id === makeEdgeId("usesRoutine", lessonId, newEntryId))).toBe(true);
    });
  });

  it("a stale token-only confirm (parked context missing) reports stale", async () => {
    await inCtx(async () => {
      const lessonId = someLessonId(await readPublished());
      const dry = (await applyCatalogEntry({ entryId: "cat-entry", targetId: lessonId })) as { content?: Array<{ text: string }> };
      const dryJson = JSON.parse(dry.content![0].text) as { confirmationToken?: string };
      // Simulate the parked context vanishing before confirm.
      const nonce = (JSON.parse(Buffer.from(dryJson.confirmationToken!, "base64url").toString("utf8")) as { n: string }).n;
      await store.deletePending(ns, `${nonce}:w`);
      const done = (await applyCatalogEntry({ confirm: true, confirmationToken: dryJson.confirmationToken })) as { content?: Array<{ text: string }> };
      const doneJson = JSON.parse(done.content![0].text) as { ok?: boolean; reason?: string };
      expect(doneJson.ok).toBe(false);
      expect(doneJson.reason).toBe("stale");
    });
  });

  it("copies a formatter under a TLM token-only (the parked mode dispatches useFormatter)", async () => {
    await inCtx(async () => {
      const courseId = (await readPublished()).nodes.find((n) => (n.labels ?? []).includes("Course"))!.id;
      const tlmId = await addTlmToPublished(courseId);
      const dry = (await applyCatalogEntry({ entryId: "cat-fmt", targetId: tlmId }, "formatter")) as { content?: Array<{ text: string }> };
      const dryJson = JSON.parse(dry.content![0].text) as { payloadStored?: boolean; confirmationToken?: string; mintedIdMap?: Record<string, string> };
      expect(dryJson.payloadStored).toBe(true);
      // Confirm with ONLY confirm + token — no mode passed, so the parked context's
      // mode is what routes this to useFormatter (not useRoutine).
      const done = (await applyCatalogEntry({ confirm: true, confirmationToken: dryJson.confirmationToken })) as { content?: Array<{ text: string }> };
      const doneJson = JSON.parse(done.content![0].text) as { phase?: string; ok?: boolean };
      expect(doneJson.phase).toBe("apply");
      expect(doneJson.ok).toBe(true);
      const newFmtId = dryJson.mintedIdMap!["cat-fmt"];
      const draft = (await readDraft())!;
      expect(draft.edges.some((e) => e.id === makeEdgeId("hasPart", tlmId, newFmtId))).toBe(true);
      expect(draft.nodes.find((n) => n.id === newFmtId)!.labels).toEqual(["Formatter"]);
    });
  });
});
