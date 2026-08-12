// ── CE1 reading — Scope C content recipes, end to end ────────────────────────
// Drives add_activity / add_material / set_material_content through the #5
// two-phase framework on the REAL reading seed, then proves the read projection
// (buildSlice, via buildGenerationContext) surfaces the authored content. Also
// checks the per-recipe availability gate and add_material's parent-kind guard.
//
// The invariant under test: what a curator stages with these recipes is what a
// draft read (preview) shows — an Activity under a session Lesson (hasPart), its
// Material carrying the scripted content (raw.content), and both reachable from
// the week's slice once authored.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { CONFIG } from "../config.js";
import { listAvailableContexts, subjectDir } from "../context/index.js";
import { resolveAdapter } from "./index.js";
import { serializeModel, toRawEnvelope } from "../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, mintNodeId, edgeId as makeEdgeId,
  addActivity, addMaterial, setMaterialContent,
  __resetMutationsForTest, __resetDraftTokensForTest,
} from "../kg-store/index.js";
import { __setStorageForTest } from "../storage/index.js";
import { __setActorForTest, type Actor } from "../actor.js";
import type { MutationGraph, GraphMutation, StoredMeta, KgNodeStore } from "../kg-store/index.js";
import type { StorageAdapter, HistoryFile, CurriculumModel } from "../types.js";

const HAS_PART = "hasPart"; // canonical LC content containment

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

const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const ns = kgNamespace("ce1", "reading");
const adapter = () => resolveAdapter("ce1", "reading")!;
const bag = () => ({ namespace: ns, profile: adapter().recipeProfile!, structuralAliases: adapter().structuralAliases!, wordingAliases: adapter().wordingAliases, lcNodeTemplate: adapter().lcNodeTemplate });
const coverage = (g: MutationGraph): string[] => adapter().coverageWarnings?.(g as never) ?? [];

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(grade, subject), CONFIG.kgFile), "utf8"));
    const a = resolveAdapter(grade, subject);
    if (!a) continue;
    const { nodes, edges } = serializeModel(a.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: a.id, nodeCount: nodes.length, edgeCount: edges.length };
    await s.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return s;
}

const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
async function readSlot(slot: "a" | "b"): Promise<MutationGraph> {
  const [nodes, edges] = await Promise.all([store.listNodes(ns, slot), store.listEdges(ns, slot)]);
  return { nodes: nodes.map(strip) as MutationGraph["nodes"], edges: edges.map(strip) as MutationGraph["edges"] };
}
async function readDraft(): Promise<MutationGraph> {
  const p = await store.readPointer(ns);
  return readSlot(p!.draftSlot!);
}
async function readPublished(): Promise<MutationGraph> {
  const p = await store.readPointer(ns);
  return readSlot(p!.publishedSlot);
}
// Hydrate a slot the way a real read does — raw envelope → adapter.parse.
const modelOf = (g: MutationGraph): CurriculumModel => adapter().parse(toRawEnvelope({ nodes: g.nodes, edges: g.edges }));

// Preview → confirm a recipe with a stable args object.
async function runRecipe<A>(mutation: GraphMutation<A>, args: A) {
  const preview = await runGraphMutation({ namespace: ns, mutation, args, coverage });
  if (preview.phase !== "preview") return { preview, confirm: null };
  const confirm = await runGraphMutation({ namespace: ns, mutation, args, confirm: true, token: preview.confirmationToken, coverage });
  return { preview, confirm };
}

// A real week-1 session Lesson id, from the published seed.
function week1SessionLesson(g: MutationGraph): string {
  const m = modelOf(g);
  const wk = m.unitsOfKind("week").find((w) => w.order === 1)!;
  const day = m.childrenOf(wk.id).find((c) => c.kind === "day")!;
  return m.childrenOf(day.id).find((c) => c.kind === "lesson")!.id;
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

describe("add_activity", () => {
  it("adds one Activity node + a hasPart edge from the lesson; dry-run stages nothing", async () => {
    const published = await readPublished();
    const lessonId = week1SessionLesson(published);
    const activityId = mintNodeId();
    const args = { ...bag(), lessonId, activityId, text: "Étape 1 : Découvrir le vocabulaire", studentGroupingType: "group", timeRequired: "10 mn" };

    const preview = await runGraphMutation({ namespace: ns, mutation: addActivity, args, coverage });
    if (preview.phase !== "preview") throw new Error("expected preview");
    expect(preview.diff.nodes.added.map((n) => n.id)).toEqual([activityId]);
    expect(preview.diff.edges.added.map((e) => e.id)).toContain(makeEdgeId(HAS_PART, lessonId, activityId));

    const confirm = await runGraphMutation({ namespace: ns, mutation: addActivity, args, confirm: true, token: preview.confirmationToken, coverage });
    expect(confirm.phase).toBe("apply");

    const draft = await readDraft();
    const node = draft.nodes.find((n) => n.id === activityId)!;
    expect(node.type).toBe("activity");
    expect(node.labels).toContain("Activity");
    // Faithful LC: title + props ride raw so they survive re-parse.
    const rawProps = node.properties.raw as Record<string, unknown>;
    expect(rawProps.description).toBe("Étape 1 : Découvrir le vocabulaire");
    expect(rawProps.normalizedType).toBe("Activity");
    expect(rawProps.studentGroupingType).toBe("group");
    expect(rawProps.educationalUse).toBe("Instruction"); // default
  });

  it("blocks an activity on a non-lesson (e.g. a week grouping)", async () => {
    const published = await readPublished();
    const m = modelOf(published);
    const weekId = m.unitsOfKind("week").find((w) => w.order === 1)!.id;
    const args = { ...bag(), lessonId: weekId, activityId: mintNodeId(), text: "bad" };
    const preview = await runGraphMutation({ namespace: ns, mutation: addActivity, args, coverage });
    expect(preview.phase).toBe("blocked");
    if (preview.phase === "blocked") expect(preview.errors.join()).toMatch(/not a lesson/i);
  });
});

describe("add_material", () => {
  it("hangs a Material off an Activity with content in raw.content; buildSlice surfaces it", async () => {
    const published = await readPublished();
    const lessonId = week1SessionLesson(published);

    // Author an activity, then a material under it.
    const activityId = mintNodeId();
    await runRecipe(addActivity, { ...bag(), lessonId, activityId, text: "Étape 3 : Écouter le texte" });
    const materialId = mintNodeId();
    const content = "<p>M lit le texte 2 fois, dramatisé.</p>";
    const { confirm } = await runRecipe(addMaterial, { ...bag(), parentId: activityId, materialId, content, materialType: "Core" });
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    const mat = draft.nodes.find((n) => n.id === materialId)!;
    expect(mat.type).toBe("material");
    expect((mat.properties.raw as Record<string, unknown>).content).toBe(content);
    expect(draft.edges.map((e) => e.id)).toContain(makeEdgeId(HAS_PART, activityId, materialId));

    // Read projection: the week-1 slice shows the activity + its material.
    const ctx = await adapter().buildGenerationContext(1, "teacher_guide", modelOf(draft)) as { curriculum: { sessions: { activities: { titre: string | null; materials: { contenu: string | null }[] }[] }[] } };
    const sessions = ctx.curriculum.sessions;
    const authored = sessions.flatMap((s) => s.activities).find((a) => a.titre === "Étape 3 : Écouter le texte")!;
    expect(authored).toBeTruthy();
    expect(authored.materials.map((mm) => mm.contenu)).toContain(content);
  });

  it("allows a Material directly on a week grouping (opening-scene image) and on a lesson", async () => {
    const published = await readPublished();
    const m = modelOf(published);
    const weekId = m.unitsOfKind("week").find((w) => w.order === 1)!.id;
    const lessonId = week1SessionLesson(published);

    const onWeek = await runRecipe(addMaterial, { ...bag(), parentId: weekId, materialId: mintNodeId(), content: "[week opening scene]", materialType: "Reference" });
    expect(onWeek.confirm?.phase).toBe("apply");
    const onLesson = await runRecipe(addMaterial, { ...bag(), parentId: lessonId, materialId: mintNodeId(), content: "[shared reading text]" });
    expect(onLesson.confirm?.phase).toBe("apply");

    const ctx = await adapter().buildGenerationContext(1, "teacher_guide", modelOf(await readDraft())) as { curriculum: { materials: { contenu: string | null }[]; sessions: { materials: { contenu: string | null }[] }[] } };
    const slice = ctx.curriculum;
    expect(slice.materials.map((x) => x.contenu)).toContain("[week opening scene]");
    expect(slice.sessions.flatMap((s) => s.materials).map((x) => x.contenu)).toContain("[shared reading text]");
  });

  it("blocks a Material on a component (not a container kind)", async () => {
    const published = await readPublished();
    const m = modelOf(published);
    const componentId = m.unitsOfKind("component")[0].id;
    const args = { ...bag(), parentId: componentId, materialId: mintNodeId(), content: "x" };
    const preview = await runGraphMutation({ namespace: ns, mutation: addMaterial, args, coverage });
    expect(preview.phase).toBe("blocked");
  });
});

describe("set_material_content", () => {
  it("replaces an existing Material's content, preserving everything else", async () => {
    const published = await readPublished();
    const lessonId = week1SessionLesson(published);
    const materialId = mintNodeId();
    await runRecipe(addMaterial, { ...bag(), parentId: lessonId, materialId, content: "old", text: "Jukki" });

    const { confirm } = await runRecipe(setMaterialContent, { ...bag(), materialId, content: "new & improved" });
    expect(confirm?.phase).toBe("apply");

    const draft = await readDraft();
    const mat = draft.nodes.find((n) => n.id === materialId)!;
    const raw = mat.properties.raw as Record<string, unknown>;
    expect(raw.content).toBe("new & improved");
    expect(raw.description).toBe("Jukki"); // title untouched
  });

  it("blocks when the id is not a material", async () => {
    const published = await readPublished();
    const lessonId = week1SessionLesson(published);
    const args = { ...bag(), materialId: lessonId, content: "x" };
    const preview = await runGraphMutation({ namespace: ns, mutation: setMaterialContent, args, coverage });
    expect(preview.phase).toBe("blocked");
    if (preview.phase === "blocked") expect(preview.errors.join()).toMatch(/not a material/i);
  });
});
