/*
 * Unit tests for the pure catalog core: enumerating entries, cloning a routine
 * subtree with fresh ids, and the useRoutine mutation's apply/validate. No store —
 * these operate on plain MutationGraph values.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { listCatalogEntries, cloneRoutineSubtree, assembleCatalog, useRoutine, SHARED_CATALOG_NAMESPACE, HOUSE_STYLE_FORMATTER } from "../catalog.js";
import { edgeId, type MutationEdge, type MutationGraph, type MutationNode } from "../../kg-store/index.js";
import { CONFIG } from "../../config.js";
import { subjectDir } from "../../context/index.js";
import type { RawGraphSnapshot } from "../../types.js";

const NS = "test/catalog";

// A routine node in store shape (non-spine: LC props live under properties.raw).
const routine = (id: string, raw: Record<string, unknown>): MutationNode =>
  ({ id, type: "InstructionalRoutine", namespace: NS, labels: ["InstructionalRoutine"], spine: false, properties: { raw } });
const material = (id: string, raw: Record<string, unknown>): MutationNode =>
  ({ id, type: "Material", namespace: NS, labels: ["Material"], spine: false, properties: { raw } });
const lesson = (id: string): MutationNode =>
  ({ id, type: "lesson", namespace: NS, labels: ["Lesson"], spine: true, properties: {} });
const hasPart = (from: string, to: string): MutationEdge =>
  ({ id: edgeId("hasPart", from, to), type: "hasPart", from, to, namespace: NS, properties: {} });

// root ─hasPart→ entry ─hasPart→ {s1 ─hasPart→ m1, s2 ─hasPart→ m2}
function catalogFixture(): MutationGraph {
  return {
    nodes: [
      routine("root", { description: "Routine library" }),
      routine("entry", { description: "Fiche de leçon", metadata: { summary: "French only" } }),
      routine("s1", { description: "Déclencheur", position: 1, timeRequired: "PT4M" }),
      routine("s2", { description: "Modelage", position: 2, timeRequired: "PT8M" }),
      material("m1", { content: "..." }),
      material("m2", { content: "..." }),
    ],
    edges: [hasPart("root", "entry"), hasPart("entry", "s1"), hasPart("entry", "s2"), hasPart("s1", "m1"), hasPart("s2", "m2")],
  };
}

describe("listCatalogEntries", () => {
  it("lists the root container's routine children as entries, with their step outline", () => {
    const entries = listCatalogEntries(catalogFixture(), "shared");
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toMatchObject({ id: "entry", kind: "routine", scope: "shared", name: "Fiche de leçon", summary: "French only", materialCount: 2 });
    expect(entry.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(entry.steps[0]).toMatchObject({ name: "Déclencheur", order: 1, timeRequired: "PT4M" });
  });

  it("tags entries with the scope they were read from", () => {
    expect(listCatalogEntries(catalogFixture(), "workspace")[0].scope).toBe("workspace");
  });

  it("does not list the root, steps, or materials as entries", () => {
    const ids = listCatalogEntries(catalogFixture(), "shared").map((e) => e.id);
    expect(ids).not.toContain("root");
    expect(ids).not.toContain("s1");
    expect(ids).not.toContain("m1");
  });

  it("returns [] for loose routines with no containment (not the catalog shape)", () => {
    // Routines with no hasPart edges at all: each is its own root with no children,
    // so nothing lists as an entry. The catalog namespace always seeds a container.
    const loose: MutationGraph = { nodes: [routine("a", { description: "A" }), routine("b", { description: "B" })], edges: [] };
    expect(listCatalogEntries(loose, "shared")).toEqual([]);
  });
});

describe("assembleCatalog", () => {
  // A source graph in RAW shape (start/end edges, LC props at properties.*), as read
  // from a subject's knowledge_graph.json: one routine subtree + unrelated nodes.
  const rawSource: RawGraphSnapshot = {
    nodes: [
      { id: "r-entry", labels: ["InstructionalRoutine"], properties: { description: "Fiche", metadata: { summary: "FR only", role: "instructional-routine" } } },
      { id: "r-s1", labels: ["InstructionalRoutine"], properties: { description: "Déclencheur", position: 1, timeRequired: "PT4M" } },
      { id: "r-m1", labels: ["Material"], properties: { content: "..." } },
      { id: "chapter-7", labels: ["LessonGrouping"], properties: { description: "Chapitre 7" } },
    ],
    relationships: [
      { id: "e1", type: "hasPart", start: "r-entry", end: "r-s1", properties: {} },
      { id: "e2", type: "hasPart", start: "r-s1", end: "r-m1", properties: {} },
      { id: "e3", type: "usesRoutine", start: "some-lesson", end: "r-entry", properties: {} },
    ],
  };

  it("re-homes each source's routine subtree under one root, dropping non-routine content", () => {
    const catalog = assembleCatalog([rawSource], SHARED_CATALOG_NAMESPACE, "root");
    const ids = catalog.nodes.map((n) => n.id);
    expect(ids).toContain("root");
    expect(ids).toEqual(expect.arrayContaining(["r-entry", "r-s1", "r-m1"]));
    expect(ids).not.toContain("chapter-7");                                   // spine/content dropped
    expect(catalog.edges.some((e) => e.id === edgeId("hasPart", "root", "r-entry"))).toBe(true);
    expect(catalog.nodes.every((n) => n.namespace.endsWith("_shared/_catalog/routines") && n.spine === false)).toBe(true);
  });

  it("produces a graph that enumerates as a catalog (round-trip through listCatalogEntries)", () => {
    const entries = listCatalogEntries(assembleCatalog([rawSource], SHARED_CATALOG_NAMESPACE, "root"), "shared");
    expect(entries.map((e) => e.id)).toEqual(["r-entry"]);
    expect(entries[0]).toMatchObject({ name: "Fiche", summary: "FR only", materialCount: 1 });
    expect(entries[0].steps.map((s) => s.id)).toEqual(["r-s1"]);
  });

  it("extracts the real CI-maths routines into two browsable catalog entries (what the seed produces)", () => {
    const bundle = JSON.parse(readFileSync(resolve(subjectDir("senegal", "ci", "maths"), CONFIG.kgFile), "utf8"));
    const entries = listCatalogEntries(assembleCatalog([{ nodes: bundle.nodes, relationships: bundle.relationships }]), "shared");
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(entries).toHaveLength(2);
    expect(byName["Fiche de leçon — enseignement explicite (30 min)"].steps).toHaveLength(5);
    expect(byName["Manuel de l'élève — structure d'un chapitre"].steps).toHaveLength(6);
    // Steps come back in ordinal order, with the teacher-guide timings preserved.
    expect(byName["Fiche de leçon — enseignement explicite (30 min)"].steps[0].timeRequired).toBe("PT4M");
  });

  it("splices the authored house-style formatter as a kind:formatter entry", () => {
    // The formatter is fed to assembleCatalog like any source; it lists as its own kind.
    const [formatter] = listCatalogEntries(assembleCatalog([HOUSE_STYLE_FORMATTER]), "shared");
    expect(formatter).toMatchObject({ kind: "formatter", name: "MOHEBS house style (docx)", materialCount: 1 });
    expect(formatter.steps).toEqual([]);   // a formatter carries a spec Material, not ordered steps
  });
});

describe("cloneRoutineSubtree", () => {
  it("mints fresh ids for the whole subtree, re-points hasPart, and localizes the namespace", () => {
    const mint = (oldId: string) => `copy-${oldId}`;
    const clone = cloneRoutineSubtree(catalogFixture(), "entry", "ci/maths", mint)!;

    expect(clone.newEntryId).toBe("copy-entry");
    expect(clone.nodes.map((n) => n.id).sort()).toEqual(["copy-entry", "copy-m1", "copy-m2", "copy-s1", "copy-s2"]);
    expect(clone.nodes.every((n) => n.namespace === "ci/maths" && n.spine === false)).toBe(true);
    // hasPart edges rewired to the new ids; the original root→entry edge is not carried.
    expect(clone.edges.map((e) => e.id)).toContain(edgeId("hasPart", "copy-entry", "copy-s1"));
    expect(clone.edges.some((e) => e.from === "entry" || e.to === "root")).toBe(false);
  });

  it("returns null for an unknown entry id", () => {
    expect(cloneRoutineSubtree(catalogFixture(), "nope", "ci/maths", (id) => id)).toBeNull();
  });
});

describe("useRoutine mutation", () => {
  const activeBase: MutationGraph = { nodes: [lesson("L1")], edges: [] };
  const clone = cloneRoutineSubtree(catalogFixture(), "entry", "ci/maths", (id) => `copy-${id}`)!;
  const args = { namespace: "ci/maths", targetId: "L1", clonedNodes: clone.nodes, clonedEdges: clone.edges, newEntryId: clone.newEntryId };

  it("apply appends the copied subtree and a usesRoutine edge from the lesson to the clone", () => {
    const after = useRoutine.apply(activeBase, args);
    expect(after.nodes.map((n) => n.id)).toContain("copy-entry");
    expect(after.edges.some((e) => e.id === edgeId("usesRoutine", "L1", "copy-entry"))).toBe(true);
  });

  it("validate rejects a non-existent target", () => {
    const res = useRoutine.validate!(activeBase, activeBase, { ...args, targetId: "ghost" });
    expect(res.errors.join(" ")).toMatch(/does not exist/);
  });

  it("validate rejects a target that is not a Lesson/Course/Activity", () => {
    const grouping: MutationGraph = { nodes: [{ id: "G1", type: "chapter", namespace: "ci/maths", labels: ["LessonGrouping"], properties: {} }], edges: [] };
    const res = useRoutine.validate!(grouping, grouping, { ...args, targetId: "G1" });
    expect(res.errors.join(" ")).toMatch(/attaches to a Lesson, Course, or Activity/);
  });

  it("validate rejects id collisions with the draft", () => {
    const collide: MutationGraph = { nodes: [lesson("L1"), { ...clone.nodes[0] }], edges: [] };
    const res = useRoutine.validate!(collide, collide, args);
    expect(res.errors.join(" ")).toMatch(/already exists/);
  });
});
