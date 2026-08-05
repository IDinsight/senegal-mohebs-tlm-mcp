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

  it("declares thematic + chapters + planning + generic views", async () => {
    const g = (await exportNamespace(mathsNs))!;
    const ids = g.meta.viewConfig.views.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(["thematique", "chapitres", "planification", "generic"]));
    const thematic = g.meta.viewConfig.views.find((v) => v.id === "thematique")!;
    expect(thematic).toMatchObject({ shape: "grouped-spine", params: { anchorKind: "domaine", expandEdge: "hasChild" } });
  });
});

describe("kg-export — reading", () => {
  it("weeks + generic views only (no maths thematic), strand carried on standards", async () => {
    const g = (await exportNamespace(readingNs))!;
    const ids = g.meta.viewConfig.views.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(["semaines", "generic"]));
    expect(ids).not.toContain("thematique");
    const wk = g.nodes.find((n) => n.kind === "week")!;
    const std = childrenOf(g, wk.id).find((n) => n.kind === "standard");
    expect(std).toBeTruthy();
    expect(std!.strand).toBeTruthy(); // reading strand lives in statement_type → strand field
  });
});
