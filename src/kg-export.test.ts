/*
 * KG-export (read-only explorer backend) — verifies the converged shape yields
 * the right display nodes, hasChild edges, and data-driven views. Seeds a memory
 * store from the real sources (parse → serializeModel), exactly like the other
 * firestore-mode suites, then calls exportNamespace.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CONFIG } from "./config.js";
import { listAvailableContexts, subjectDir } from "./context/index.js";
import { resolveAdapter } from "./adapters/index.js";
import { serializeModel } from "./curriculum/index.js";
import { __setKgStoreForTest, createMemoryKgStore, kgNamespace } from "./kg-store/index.js";
import { exportNamespace } from "./kg-export.js";
import type { KgNodeStore, StoredMeta } from "./kg-store/index.js";

const priorEnv = process.env.KG_SOURCE;
const contexts = listAvailableContexts();

async function seed(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(grade, subject), CONFIG.kgFile), "utf8"));
    const a = resolveAdapter(grade, subject);
    if (!a) continue;
    const ns = kgNamespace(grade, subject);
    const { nodes, edges } = serializeModel(a.parse(raw), ns);
    const meta: StoredMeta = { contentHash: "t", seededAt: "1970-01-01T00:00:00Z", adapterId: a.id, nodeCount: nodes.length, edgeCount: edges.length };
    await s.writeSlot(ns, "a", { nodes, edges, meta });
    await s.ensurePointer(ns, "a");
  }
  return s;
}

beforeAll(async () => { process.env.KG_SOURCE = "firestore"; __setKgStoreForTest(await seed()); });
afterAll(() => { if (priorEnv === undefined) delete process.env.KG_SOURCE; else process.env.KG_SOURCE = priorEnv; __setKgStoreForTest(null); });

const mathsNs = kgNamespace("ci", "maths");
const readingNs = kgNamespace("ce1", "reading");
const childrenOf = (g: NonNullable<Awaited<ReturnType<typeof exportNamespace>>>, id: string) =>
  g.edges.filter((e) => e.r === "hasChild" && e.s === id).map((e) => g.nodes.find((n) => n.id === e.t)!);

// The explorer now follows the LC ontology ONLY: nodes are categorized/coloured
// by their LC LABEL, and views are generic (containment hierarchy + by-label).
describe("kg-export — LC ontology (maths)", () => {
  it("categorizes nodes by LC label; taxonomy lists the present labels in order", async () => {
    const g = (await exportNamespace(mathsNs))!;
    expect(g).toBeTruthy();
    expect(g.meta.counts.byKind).toMatchObject({ StandardsFramework: 1, Course: 2, LessonGrouping: 25, Lesson: 137, Activity: 322, LearningComponent: 80 });
    expect(g.meta.counts.byKind.StandardsFrameworkItem).toBeGreaterThan(0);
    expect(g.meta.counts.byKind.Curriculum).toBeUndefined(); // canonical: relabeled to Activity/LessonGrouping
    expect(g.meta.counts.byKind.Course).toBe(2);             // two content roots: "Outil de l'élève" (student) + "Guide de l'enseignant" (teacher)
    // every node's legend category IS its LC label — no subject roles/kinds
    expect(g.nodes.every((n) => n.cat === n.label && n.kind === n.label)).toBe(true);
    expect(g.meta.taxonomy.map((x) => x.key)).toEqual(["StandardsFramework", "StandardsFrameworkItem", "Course", "LessonGrouping", "Lesson", "Activity", "LearningComponent"]);
    expect(g.meta.taxonomy.every((x) => /^#[0-9a-f]{6}$/i.test(x.color) && x.label.fr && x.label.en)).toBe(true);
  });

  it("declares LC-ontology views only: hierarchy (containment) + by-label", async () => {
    const g = (await exportNamespace(mathsNs))!;
    expect(g.meta.viewConfig.views.map((v) => v.id)).toEqual(["hierarchy", "generic"]);
    const hier = g.meta.viewConfig.views.find((v) => v.id === "hierarchy") as any;
    expect(hier.params).toMatchObject({ anchorKind: "StandardsFramework", expandEdge: "hasChild" });
    expect(hier.params.groupBy).toEqual([]);
  });

  it("containment walks hasChild from the framework; components reachable via the supports fold", async () => {
    const g = (await exportNamespace(mathsNs))!;
    const fw = g.nodes.find((n) => n.label === "StandardsFramework")!;
    expect(childrenOf(g, fw.id).length).toBeGreaterThan(0); // framework → items
    // a component attaches via `supports`, folded to a hasChild display edge, so
    // every component is a tree child — if the fold regresses, they vanish.
    const hasChildTargets = new Set(g.edges.filter((e) => e.r === "hasChild").map((e) => e.t));
    const components = g.nodes.filter((n) => n.label === "LearningComponent");
    expect(components.length).toBeGreaterThan(0);
    expect(components.every((c) => hasChildTargets.has(c.id))).toBe(true);
  });

  it("display edges carry the real relation (honest badge); illustrative tasks nest under their component", async () => {
    const g = (await exportNamespace(mathsNs))!;
    // Every edge has a traversal type AND a real type for the badge.
    expect(g.edges.every((e) => typeof e.rel === "string" && e.rel.length > 0)).toBe(true);
    // Content containment folds to a hasChild TRAVERSAL edge but keeps its real
    // type — so Course→chapter badges as "hasPart", not a blanket "hasChild".
    // (Two Courses now exist; pin the student book by its title.)
    const course = g.nodes.find((n) => n.label === "Course" && n.desc === "Outil de l'élève")!;
    const courseEdges = g.edges.filter((e) => e.s === course.id);
    expect(courseEdges.length).toBe(25);
    expect(courseEdges.every((e) => e.r === "hasChild" && e.rel === "hasPart")).toBe(true);

    // An illustrative Activity is re-parented under the LearningComponent it
    // exemplifies (metadata.illustratesComponent), rel "illustrates" — NOT left as
    // a sibling under the standard it merely aligns to.
    const compIds = new Set(g.nodes.filter((n) => n.label === "LearningComponent").map((n) => n.id));
    const act = g.nodes.find((n) => n.label === "Activity" && compIds.has((n.props as any)?.illustratesComponent?.id))!;
    expect(act).toBeTruthy();
    const compId = (act.props as any).illustratesComponent.id as string;
    const parents = g.edges.filter((e) => e.r === "hasChild" && e.t === act.id);
    expect(parents).toHaveLength(1);            // exactly one containment parent
    expect(parents[0].s).toBe(compId);          // and it's the component, not the SFI
    expect(parents[0].rel).toBe("illustrates");
  });

  it("node detail carries the raw LC properties generically (no subject fields on the node)", async () => {
    const g = (await exportNamespace(mathsNs))!;
    const lesson = g.nodes.find((n) => n.label === "Lesson")!;
    expect(lesson.props && typeof lesson.props === "object").toBe(true);
    expect((lesson as Record<string, unknown>).dom).toBeUndefined();
    expect((lesson as Record<string, unknown>).pal).toBeUndefined();
    expect((lesson as Record<string, unknown>).strand).toBeUndefined();
  });
});

describe("kg-export — LC ontology (reading)", () => {
  it("same LC labels + views; reading carries no Curriculum tasks", async () => {
    const g = (await exportNamespace(readingNs))!;
    expect(g.meta.counts.byKind).toMatchObject({ StandardsFramework: 1, LessonGrouping: 127, Lesson: 462, LearningComponent: 1031 });
    expect(g.meta.counts.byKind.StandardsFrameworkItem).toBeGreaterThan(0);
    expect(g.meta.counts.byKind.Curriculum).toBeUndefined();
    expect(g.nodes.every((n) => n.cat === n.label)).toBe(true);
    expect(g.meta.viewConfig.views.map((v) => v.id)).toEqual(["hierarchy", "generic"]);
    expect(g.meta.taxonomy.map((x) => x.key)).toEqual(["StandardsFramework", "StandardsFrameworkItem", "LessonGrouping", "Lesson", "LearningComponent"]);
  });
});
