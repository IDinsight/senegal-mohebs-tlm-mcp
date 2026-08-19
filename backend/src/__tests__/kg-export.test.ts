/*
 * KG-export (read-only explorer backend) — verifies the converged shape yields
 * the right display nodes, hasChild edges, and data-driven views. Seeds a memory
 * store from the real sources (parse → serializeModel), exactly like the other
 * firestore-mode suites, then calls exportNamespace.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { listAvailableContexts } from "../context/index.js";
import { subjectDir, KG_FIXTURE } from "./index.js";
import { resolveAdapter } from "../adapters/index.js";
import { serializeModel } from "../curriculum/index.js";
import { __setKgStoreForTest, createMemoryKgStore, kgNamespace, edgeId as makeEdgeId } from "../kg-store/index.js";
import { exportNamespace, exportCatalog, exportCatalogEntry } from "../kg-export.js";
import { SHARED_CATALOG_NAMESPACE, catalogNamespace } from "../kg-recipes/index.js";
import { DEFAULT_WORKSPACE } from "../config.js";
import type { KgNodeStore, StoredMeta, StoredNode, StoredEdge } from "../kg-store/index.js";

const priorEnv = process.env.KG_SOURCE;
const contexts = listAvailableContexts();

// A small catalog fixture in store shape (non-spine; LC props under properties.raw)
// for one catalog namespace: root ─hasPart→ {a routine entry with 2 steps, a formatter}.
async function seedCatalog(store: KgNodeStore, namespace: string): Promise<void> {
  const node = (id: string, label: string, raw: Record<string, unknown>): Omit<StoredNode, "slot"> =>
    ({ id, type: label, namespace, labels: [label], spine: false, properties: { raw } });
  const edge = (from: string, to: string): Omit<StoredEdge, "slot"> =>
    ({ id: makeEdgeId("hasPart", from, to), type: "hasPart", from, to, namespace, properties: {} });
  const p = namespace.replace(/[^a-z]/gi, "").slice(-6); // per-namespace id prefix so shared/workspace ids don't collide
  const nodes = [
    node(`${p}-root`, "InstructionalRoutine", { description: "Library" }),
    node(`${p}-entry`, "InstructionalRoutine", { description: "Fiche de leçon", metadata: { summary: "French only" } }),
    node(`${p}-s1`, "InstructionalRoutine", { description: "Déclencheur", position: 1, timeRequired: "PT4M" }),
    node(`${p}-s2`, "InstructionalRoutine", { description: "Modelage", position: 2 }),
    node(`${p}-m1`, "Material", { content: "corps déclencheur" }),
    node(`${p}-fmt`, "InstructionalRoutine", { description: "House style", metadata: { catalogKind: "formatter" } }),
    node(`${p}-fmt-spec`, "Material", { content: "palette + fonts" }),
  ];
  const edges = [
    edge(`${p}-root`, `${p}-entry`), edge(`${p}-entry`, `${p}-s1`), edge(`${p}-entry`, `${p}-s2`), edge(`${p}-s1`, `${p}-m1`),
    edge(`${p}-root`, `${p}-fmt`), edge(`${p}-fmt`, `${p}-fmt-spec`),
  ];
  const meta: StoredMeta = { contentHash: "t", seededAt: "1970-01-01T00:00:00Z", adapterId: "catalog", nodeCount: nodes.length, edgeCount: edges.length };
  await store.writeSlot(namespace, "a", { nodes, edges, meta });
  await store.ensurePointer(namespace, "a");
}

async function seed(): Promise<KgNodeStore> {
  const store = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const adapter = resolveAdapter(workspace, grade, subject);
    if (!adapter) continue;
    const ns = kgNamespace(grade, subject);
    const { nodes, edges } = serializeModel(adapter.parse(raw), ns);
    const meta: StoredMeta = { contentHash: "t", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await store.writeSlot(ns, "a", { nodes, edges, meta });
    await store.ensurePointer(ns, "a");
  }
  // Both libraries the Catalog tab reads: the shared one and the default workspace's.
  await seedCatalog(store, SHARED_CATALOG_NAMESPACE);
  await seedCatalog(store, catalogNamespace(DEFAULT_WORKSPACE));
  return store;
}

beforeAll(async () => { process.env.KG_SOURCE = "firestore"; __setKgStoreForTest(await seed()); });
afterAll(() => { if (priorEnv === undefined) delete process.env.KG_SOURCE; else process.env.KG_SOURCE = priorEnv; __setKgStoreForTest(null); });

const mathsNs = kgNamespace("ci", "maths");
const readingNs = kgNamespace("ce1", "reading");
const childrenOf = (graph: NonNullable<Awaited<ReturnType<typeof exportNamespace>>>, id: string) =>
  graph.edges.filter((e) => e.r === "hasChild" && e.s === id).map((e) => graph.nodes.find((n) => n.id === e.t)!);

// The explorer now follows the LC ontology ONLY: nodes are categorized/coloured
// by their LC LABEL, and views are generic (containment hierarchy + by-label).
describe("kg-export — LC ontology (maths)", () => {
  it("categorizes nodes by LC label; taxonomy lists the present labels in order", async () => {
    const graph = (await exportNamespace(mathsNs))!;
    expect(graph).toBeTruthy();
    // LessonGrouping = 25 chapters + 23 weeks (weeks are canonical content groupings now).
    expect(graph.meta.counts.byKind).toMatchObject({ StandardsFramework: 1, Course: 2, LessonGrouping: 48, Lesson: 137, Activity: 322, LearningComponent: 80 });
    expect(graph.meta.counts.byKind.StandardsFrameworkItem).toBeGreaterThan(0);
    expect(graph.meta.counts.byKind.Curriculum).toBeUndefined(); // canonical: relabeled to Activity/LessonGrouping
    expect(graph.meta.counts.byKind.Course).toBe(2);             // two content roots: "Outil de l'élève" (student) + "Guide de l'enseignant" (teacher)
    // every node's legend category IS its LC label — no subject roles/kinds
    expect(graph.nodes.every((n) => n.cat === n.label && n.kind === n.label)).toBe(true);
    // + Material and InstructionalRoutine: the shared "fiche de leçon" routine (Phase 1).
    expect(graph.meta.taxonomy.map((x) => x.key)).toEqual(["StandardsFramework", "StandardsFrameworkItem", "Course", "LessonGrouping", "Lesson", "Activity", "Material", "LearningComponent", "InstructionalRoutine"]);
    expect(graph.meta.taxonomy.every((x) => /^#[0-9a-f]{6}$/i.test(x.color) && x.label.fr && x.label.en)).toBe(true);
  });

  it("declares the LC lenses present in the data: standards + components + curriculum + progression, then by-type", async () => {
    const graph = (await exportNamespace(mathsNs))!;
    // Maths has every layer: a standards spine, LearningComponents, the content
    // tree (Course/Lesson/Activity), and chapter prerequisites (hasDependency →
    // buildsTowards). So all four LC lenses + the generic view appear.
    expect(graph.meta.viewConfig.views.map((v) => v.id)).toEqual(["standards", "components", "curriculum", "progression", "generic"]);
    // Standards is the full containment tree (former "Hierarchy") — components and
    // curriculum fold in via hasChild, so it stays a grouped-spine on the framework.
    const standardsView = graph.meta.viewConfig.views.find((v) => v.id === "standards") as any;
    expect(standardsView.shape).toBe("grouped-spine");
    expect(standardsView.params).toMatchObject({ anchorKind: "StandardsFramework", expandEdge: "hasChild" });
    expect(standardsView.params.groupBy).toEqual([]);
    const progressionView = graph.meta.viewConfig.views.find((v) => v.id === "progression") as any;
    expect(progressionView.params).toMatchObject({ edge: "buildsTowards" });
    // hasDependency is normalised onto buildsTowards for the progression view.
    expect(graph.edges.some((e) => e.rel === "buildsTowards")).toBe(true);
    expect(graph.edges.some((e) => e.rel === "hasDependency")).toBe(false);
  });

  it("containment walks hasChild from the framework; components reachable via the supports fold", async () => {
    const graph = (await exportNamespace(mathsNs))!;
    const framework = graph.nodes.find((n) => n.label === "StandardsFramework")!;
    expect(childrenOf(graph, framework.id).length).toBeGreaterThan(0); // framework → items
    // a component attaches via `supports`, folded to a hasChild display edge, so
    // every component is a tree child — if the fold regresses, they vanish.
    const hasChildTargets = new Set(graph.edges.filter((e) => e.r === "hasChild").map((e) => e.t));
    const components = graph.nodes.filter((n) => n.label === "LearningComponent");
    expect(components.length).toBeGreaterThan(0);
    expect(components.every((c) => hasChildTargets.has(c.id))).toBe(true);
  });

  it("the components view flows LC → item → framework (reversed hasChild tree)", async () => {
    const graph = (await exportNamespace(mathsNs))!;
    const view = graph.meta.viewConfig.views.find((v) => v.id === "components") as any;
    expect(view.shape).toBe("label-tree");
    expect(view.params).toMatchObject({ reverse: true, rootKinds: ["LearningComponent"], expandEdge: "hasChild" });

    // Reproduce the client's reversed label-tree walk: among included labels, each
    // hasChild edge target parents its source, so a LearningComponent heads its own
    // branch and we walk OUT to the framework.
    const includedLabels = new Set(view.params.includeLabels as string[]);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const isIncluded = (id: string) => includedLabels.has(byId.get(id)?.label ?? "");
    const childrenOf = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (edge.r !== "hasChild" || !isIncluded(edge.s) || !isIncluded(edge.t)) continue;
      // reversed: the target parents the source
      const siblings = childrenOf.get(edge.t) ?? childrenOf.set(edge.t, []).get(edge.t)!;
      siblings.push(edge.s);
    }
    const components = graph.nodes.filter((n) => n.label === "LearningComponent");
    expect(components.length).toBeGreaterThan(0);
    // Every component reaches a StandardsFramework by walking outward from itself.
    const reachesFramework = (start: string) => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (byId.get(id)?.label === "StandardsFramework") return true;
        for (const childId of childrenOf.get(id) ?? []) {
          stack.push(childId);
        }
      }
      return false;
    };
    expect(components.every((c) => reachesFramework(c.id))).toBe(true);
  });

  it("display edges carry the real relation (honest badge); illustrative tasks nest under their component", async () => {
    const graph = (await exportNamespace(mathsNs))!;
    // Every edge has a traversal type AND a real type for the badge.
    expect(graph.edges.every((e) => typeof e.rel === "string" && e.rel.length > 0)).toBe(true);
    // Content containment folds to a hasChild TRAVERSAL edge but keeps its real
    // type — so Course→chapter badges as "hasPart", not a blanket "hasChild".
    // (Two Courses now exist; pin the student book by its title. The Course also
    // carries usesRoutine→formatter edges now, so scope to the containment edges.)
    const course = graph.nodes.find((n) => n.label === "Course" && n.desc === "Outil de l'élève")!;
    const courseEdges = graph.edges.filter((e) => e.s === course.id && e.rel === "hasPart");
    expect(courseEdges.length).toBe(25);
    expect(courseEdges.every((e) => e.r === "hasChild" && e.rel === "hasPart")).toBe(true);

    // An illustrative Activity is re-parented under the LearningComponent it
    // exemplifies (metadata.illustratesComponent), rel "illustrates" — NOT left as
    // a sibling under the standard it merely aligns to.
    const componentIds = new Set(graph.nodes.filter((n) => n.label === "LearningComponent").map((n) => n.id));
    const activity = graph.nodes.find((n) => n.label === "Activity" && componentIds.has((n.props as any)?.illustratesComponent?.id))!;
    expect(activity).toBeTruthy();
    const componentId = (activity.props as any).illustratesComponent.id as string;
    const parents = graph.edges.filter((e) => e.r === "hasChild" && e.t === activity.id);
    expect(parents).toHaveLength(1);            // exactly one containment parent
    expect(parents[0].s).toBe(componentId);     // and it's the component, not the SFI
    expect(parents[0].rel).toBe("illustrates");
  });

  it("curriculum view lets a lesson walk out to its aligned standard, then to that standard's supporting components", async () => {
    const graph = (await exportNamespace(mathsNs))!;
    const view = graph.meta.viewConfig.views.find((v) => v.id === "curriculum") as any;
    expect(view.shape).toBe("label-tree");
    // The tail is the graph-native way to reach the alignment the content walk folds
    // away: Lesson --hasEducationalAlignment--> SFI --supports--> LearningComponent.
    expect(view.params.alignmentTail).toEqual([
      { from: "Lesson", rel: "hasEducationalAlignment", dir: "in" },
      { from: "StandardsFrameworkItem", rel: "supports", dir: "out" },
    ]);

    // Reproduce the client's tail walk over the REAL edge types (graphModel builds
    // realIn/realOut the same way): a step's `dir` picks which endpoint is the node.
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const realIn = new Map<string, string[]>();  // rel|to → [from]
    const realOut = new Map<string, string[]>(); // rel|from → [to]
    for (const e of graph.edges) {
      (realOut.get(`${e.rel}|${e.s}`) ?? realOut.set(`${e.rel}|${e.s}`, []).get(`${e.rel}|${e.s}`)!).push(e.t);
      (realIn.get(`${e.rel}|${e.t}`) ?? realIn.set(`${e.rel}|${e.t}`, []).get(`${e.rel}|${e.t}`)!).push(e.s);
    }
    const lessons = graph.nodes.filter((n) => n.label === "Lesson");
    // At least one lesson reaches an SFI, and that SFI reaches ≥1 LearningComponent.
    const chains = lessons
      .map((lesson) => {
        const sfis = (realIn.get(`hasEducationalAlignment|${lesson.id}`) ?? []).filter((id) => byId.get(id)?.label === "StandardsFrameworkItem");
        const comps = sfis.flatMap((sfi) => (realOut.get(`supports|${sfi}`) ?? []).filter((id) => byId.get(id)?.label === "LearningComponent"));
        return { sfis, comps };
      })
      .filter((c) => c.sfis.length > 0 && c.comps.length > 0);
    expect(chains.length).toBeGreaterThan(0);
  });

  it("node detail carries the raw LC properties generically (no subject fields on the node)", async () => {
    const graph = (await exportNamespace(mathsNs))!;
    const lesson = graph.nodes.find((n) => n.label === "Lesson")!;
    expect(lesson.props && typeof lesson.props === "object").toBe(true);
    expect((lesson as Record<string, unknown>).dom).toBeUndefined();
    expect((lesson as Record<string, unknown>).pal).toBeUndefined();
    expect((lesson as Record<string, unknown>).strand).toBeUndefined();
  });
});

// The Catalog tab's backend: exportCatalog reads BOTH libraries visible from a
// curriculum namespace (shared + that workspace's own), and exportCatalogEntry
// renders one entry's full spec as markdown.
describe("kg-export — catalog", () => {
  it("returns both scopes' entries, each tagged with scope + kind + outline", async () => {
    const catalog = (await exportCatalog(mathsNs))!;
    expect(catalog).toBeTruthy();
    // Two libraries: shared + the maths namespace's workspace.
    expect(catalog.scopes.map((s) => s.scope).sort()).toEqual(["shared", "workspace"]);
    expect(catalog.scopes.some((s) => s.namespace === SHARED_CATALOG_NAMESPACE)).toBe(true);

    const shared = catalog.entries.filter((e) => e.scope === "shared");
    const workspace = catalog.entries.filter((e) => e.scope === "workspace");
    expect(shared.length).toBe(2);    // a routine + a formatter
    expect(workspace.length).toBe(2);

    const routine = shared.find((e) => e.kind === "routine")!;
    expect(routine.name).toBe("Fiche de leçon");
    expect(routine.summary).toBe("French only");
    expect(routine.steps.map((s) => s.name)).toEqual(["Déclencheur", "Modelage"]); // ordered by position
    expect(routine.materialCount).toBe(1);

    const formatter = shared.find((e) => e.kind === "formatter")!;
    expect(formatter.name).toBe("House style");
    expect(formatter.steps).toEqual([]);  // a formatter's Materials are spec, not steps
  });

  it("renders one entry's full authored spec as markdown; unknown id → null", async () => {
    const catalog = (await exportCatalog(mathsNs))!;
    const routine = catalog.entries.find((e) => e.scope === "shared" && e.kind === "routine")!;
    const md = await exportCatalogEntry(mathsNs, routine.id);
    expect(md).toContain("# Fiche de leçon");
    expect(md).toContain("## Déclencheur");
    expect(md).toContain("corps déclencheur");
    expect(await exportCatalogEntry(mathsNs, "no-such-entry")).toBeNull();
  });

  it("returns null for a namespace that isn't a curriculum context", async () => {
    expect(await exportCatalog(SHARED_CATALOG_NAMESPACE)).toBeNull();
  });
});

describe("kg-export — LC ontology (reading)", () => {
  it("same LC labels; reading has standards + components + curriculum but no progression (no buildsTowards)", async () => {
    const graph = (await exportNamespace(readingNs))!;
    expect(graph.meta.counts.byKind).toMatchObject({ StandardsFramework: 1, LessonGrouping: 127, Lesson: 462, LearningComponent: 1031 });
    expect(graph.meta.counts.byKind.StandardsFrameworkItem).toBeGreaterThan(0);
    expect(graph.meta.counts.byKind.Curriculum).toBeUndefined();
    expect(graph.nodes.every((n) => n.cat === n.label)).toBe(true);
    // Reading has a content layer (LessonGrouping/Lesson) → a curriculum view, but
    // no chapter prerequisites → no progression view.
    expect(graph.meta.viewConfig.views.map((v) => v.id)).toEqual(["standards", "components", "curriculum", "generic"]);
    expect(graph.meta.taxonomy.map((x) => x.key)).toEqual(["StandardsFramework", "StandardsFrameworkItem", "LessonGrouping", "Lesson", "LearningComponent"]);
  });
});
