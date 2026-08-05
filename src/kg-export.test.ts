// KG-export (read-only explorer backend) — verifies the converged shape yields
// the right display nodes, hasChild edges, and data-driven views. Seeds a memory
// store from the real sources (parse → serializeModel), exactly like the other
// firestore-mode suites, then calls exportNamespace.
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

describe("kg-export — maths (converged two-axis shape)", () => {
  it("exposes domaine / chapter / week / lesson node kinds", async () => {
    const g = (await exportNamespace(mathsNs))!;
    expect(g).toBeTruthy();
    expect(g.meta.counts.byKind).toMatchObject({ domaine: 4, chapter: 25, week: 23, lesson: 112 });
  });

  it("walks the CONTENT axis via hasChild: domaine → chapter → lesson", async () => {
    const g = (await exportNamespace(mathsNs))!;
    const dom = g.nodes.find((n) => n.kind === "domaine")!;
    const chapters = childrenOf(g, dom.id).filter((n) => n.kind === "chapter");
    expect(chapters.length).toBeGreaterThan(0);
    expect(childrenOf(g, chapters[0].id).some((n) => n.kind === "lesson")).toBe(true);
    // domaines are ordered for the thematic view
    expect(g.nodes.filter((n) => n.kind === "domaine").every((n) => typeof n.ord === "number")).toBe(true);
    // colour propagation: the chapter (and its lessons) inherit the domaine name
    expect(chapters[0].dom).toBe(dom.dom);
    expect(childrenOf(g, chapters[0].id).filter((n) => n.kind === "lesson").every((l) => l.dom === dom.dom)).toBe(true);
  });

  it("walks the SCHEDULE axis via hasChild: week → lesson", async () => {
    const g = (await exportNamespace(mathsNs))!;
    const wk = g.nodes.find((n) => n.kind === "week")!;
    expect(childrenOf(g, wk.id).some((n) => n.kind === "lesson")).toBe(true);
  });

  it("tags nodes with a graph-agnostic category and emits the taxonomy legend", async () => {
    const g = (await exportNamespace(mathsNs))!;
    // role/kind → category, independent of the subject's own vocabulary
    const catCount = (c: string) => g.nodes.filter((n) => n.cat === c).length;
    expect(catCount("strand")).toBe(4);       // domaine
    expect(catCount("subtopic")).toBe(25);     // chapter
    expect(catCount("expectation")).toBe(112); // lesson (OS)
    expect(catCount("week")).toBe(23);
    expect(catCount("component")).toBeGreaterThan(0);
    expect(catCount("task")).toBeGreaterThan(0);
    // taxonomy lists present categories in canonical order, each with a colour
    expect(g.meta.taxonomy.map((x) => x.key)).toEqual(["strand", "subtopic", "expectation", "component", "task", "week"]);
    expect(g.meta.taxonomy.every((x) => /^#[0-9a-f]{6}$/i.test(x.color) && x.label.fr && x.label.en)).toBe(true);
  });

  it("declares thematic (domaine) + planification (palier→week) + generic", async () => {
    const g = (await exportNamespace(mathsNs))!;
    expect(g.meta.viewConfig.views.map((v) => v.id)).toEqual(["thematique", "planification", "generic"]);
    const thematic = g.meta.viewConfig.views.find((v) => v.id === "thematique") as any;
    expect(thematic.params).toMatchObject({ anchorKind: "domaine", expandEdge: "hasChild" });
    const plan = g.meta.viewConfig.views.find((v) => v.id === "planification") as any;
    expect(plan.params).toMatchObject({ anchorKind: "week", expandEdge: "hasChild" });
    expect(plan.params.groupBy[0].key).toBe("pal");
    // weeks carry a (derived) palier so the planning view can bucket them by tier
    expect(g.nodes.filter((n) => n.kind === "week").every((w) => w.pal !== "" && w.pal != null)).toBe(true);
  });
});

describe("kg-export — reading", () => {
  it("thematic (by strand) + planification + generic; spine filter drops orphan standards", async () => {
    const g = (await exportNamespace(readingNs))!;
    expect(g.meta.viewConfig.views.map((v) => v.id)).toEqual(["thematique", "planification", "generic"]);
    const thematic = g.meta.viewConfig.views.find((v) => v.id === "thematique") as any;
    expect(thematic.params).toMatchObject({ anchorKind: "standard", expandEdge: "hasChild" });
    expect(thematic.params.groupBy[0].key).toBe("strand");
    // every exported standard is week-connected (orphans pruned) and carries its strand
    const isChild = new Set(g.edges.filter((e) => e.r === "hasChild").map((e) => e.t));
    const standards = g.nodes.filter((n) => n.kind === "standard");
    expect(standards.length).toBeGreaterThan(0);
    expect(standards.every((s) => isChild.has(s.id))).toBe(true);
    expect(standards.every((s) => s.strand)).toBe(true);
  });

  it("categorizes the reading spine (standards = expectation) and its taxonomy omits absent categories", async () => {
    const g = (await exportNamespace(readingNs))!;
    // reading spine is week → standard → component; standards carry role=expectation
    expect(g.nodes.filter((n) => n.kind === "standard").every((s) => s.cat === "expectation")).toBe(true);
    // no strand/subtopic/task NODES in the reading spine → those legend entries drop out
    const keys = g.meta.taxonomy.map((x) => x.key);
    expect(keys).toEqual(["expectation", "component", "week"]);
  });
});
