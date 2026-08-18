/*
 * Unit tests for the pure catalog core: enumerating entries, cloning a routine
 * subtree with fresh ids, and the useRoutine mutation's apply/validate. No store —
 * these operate on plain MutationGraph values.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { listCatalogEntries, renderCatalogEntry, cloneRoutineSubtree, assembleCatalog, useRoutine, catalogNamespace, SHARED_CATALOG_NAMESPACE, CATALOG_ROOT_ID } from "../catalog.js";
import { edgeId, type MutationEdge, type MutationGraph, type MutationNode } from "../../kg-store/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import type { RawGraphSnapshot } from "../../types.js";

// A formatter source in RAW shape (an InstructionalRoutine entry + one Material,
// catalogKind:formatter). The production formatters live in scripts/seed-catalog.mjs;
// these fixtures exercise the assembleCatalog mechanism without depending on that content.
const rawFormatter = (id: string, name: string): RawGraphSnapshot => ({
  nodes: [
    { id, labels: ["InstructionalRoutine"], properties: { description: name, metadata: { role: "instructional-routine", catalogKind: "formatter" } } },
    { id: `${id}-spec`, labels: ["Material"], properties: { content: "spec…", metadata: { role: "instructional-routine-material" } } },
  ],
  relationships: [{ id: `${id}-hp`, type: "hasPart", start: id, end: `${id}-spec`, properties: {} }],
});

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

  it("classifies a formatter by metadata — catalogKind OR role:formatter, else routine", () => {
    // Three sibling entries under one root: a seeded-style formatter (catalogKind), an
    // author-built formatter that overloads role:"formatter" (no catalogKind — the bug
    // these lists mis-read as routines), and a plain routine (role:instructional-routine).
    const g: MutationGraph = {
      nodes: [
        routine("root", { description: "Routine library" }),
        routine("fmt-kind", { description: "Seeded formatter", metadata: { role: "instructional-routine", catalogKind: "formatter" } }),
        routine("fmt-role", { description: "Authored formatter", metadata: { role: "formatter" } }),
        routine("plain", { description: "A routine", metadata: { role: "instructional-routine" } }),
      ],
      edges: [hasPart("root", "fmt-kind"), hasPart("root", "fmt-role"), hasPart("root", "plain")],
    };
    const kindById = Object.fromEntries(listCatalogEntries(g, "workspace").map((e) => [e.id, e.kind]));
    expect(kindById).toEqual({ "fmt-kind": "formatter", "fmt-role": "formatter", plain: "routine" });
  });
});

describe("renderCatalogEntry", () => {
  it("renders a routine entry: summary + ordered steps + each step's Material content", () => {
    const g: MutationGraph = {
      nodes: [
        routine("root", { description: "Routine library" }),
        routine("entry", { description: "Fiche de leçon", metadata: { summary: "French only." } }),
        routine("s1", { description: "Déclencheur", position: 1, timeRequired: "PT4M" }),
        routine("s2", { description: "Modelage", position: 2 }),
        material("m1", { content: "Trigger spec." }),
        material("m2", { content: "Model spec." }),
      ],
      edges: [hasPart("root", "entry"), hasPart("entry", "s1"), hasPart("entry", "s2"), hasPart("s1", "m1"), hasPart("s2", "m2")],
    };
    const md = renderCatalogEntry(g, "entry", "shared")!;
    expect(md).toContain("# Fiche de leçon");
    expect(md).toContain("routine · shared catalog");
    expect(md).toContain("French only.");
    expect(md).toContain("## Déclencheur  (PT4M)");
    expect(md).toContain("Trigger spec.");
    expect(md).toContain("Model spec.");
    expect(md.indexOf("Déclencheur")).toBeLessThan(md.indexOf("Modelage"));   // ordinal order
  });

  it("renders a formatter entry's direct Material spec (no steps)", () => {
    const g: MutationGraph = {
      nodes: [
        routine("root", { description: "Routine library" }),
        routine("fmt", { description: "House style", metadata: { catalogKind: "formatter", summary: "Apply everywhere." } }),
        material("spec", { content: "Palette: green." }),
      ],
      edges: [hasPart("root", "fmt"), hasPart("fmt", "spec")],
    };
    const md = renderCatalogEntry(g, "fmt", "workspace")!;
    expect(md).toContain("# House style");
    expect(md).toContain("formatter · workspace catalog");
    expect(md).toContain("Apply everywhere.");
    expect(md).toContain("Palette: green.");
  });

  it("labels a role:formatter entry as a formatter in the header (get_catalog_entry path)", () => {
    // Same fix as listCatalogEntries: an author-built formatter tags role:"formatter"
    // (no catalogKind), so its detail header must read "formatter", not "routine".
    const g: MutationGraph = {
      nodes: [
        routine("root", { description: "Routine library" }),
        routine("fmt", { description: "House style", metadata: { role: "formatter", summary: "Apply everywhere." } }),
        material("spec", { content: "Palette: green." }),
      ],
      edges: [hasPart("root", "fmt"), hasPart("fmt", "spec")],
    };
    const md = renderCatalogEntry(g, "fmt", "workspace")!;
    expect(md).toContain("formatter · workspace catalog");
    expect(md).toContain("Palette: green.");   // its spec Material renders (not treated as a step)
  });

  it("returns null for an unknown id or a non-routine node", () => {
    expect(renderCatalogEntry(catalogFixture(), "nope", "shared")).toBeNull();
    expect(renderCatalogEntry(catalogFixture(), "m1", "shared")).toBeNull();
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
    const bundle = JSON.parse(readFileSync(resolve(subjectDir("senegal", "ci", "maths"), KG_FIXTURE), "utf8"));
    const entries = listCatalogEntries(assembleCatalog([{ nodes: bundle.nodes, relationships: bundle.relationships }]), "shared");
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(entries).toHaveLength(2);
    expect(byName["Fiche de leçon — enseignement explicite (30 min)"].steps).toHaveLength(5);
    expect(byName["Manuel de l'élève — structure d'un chapitre"].steps).toHaveLength(6);
    // Steps come back in ordinal order, with the teacher-guide timings preserved.
    expect(byName["Fiche de leçon — enseignement explicite (30 min)"].steps[0].timeRequired).toBe("PT4M");
  });

  it("adds an authored formatter (passed via `authored`) as a kind:formatter entry", () => {
    // Formatters come through the `authored` param, taken whole; they list as their own kind.
    const [formatter] = listCatalogEntries(assembleCatalog([], SHARED_CATALOG_NAMESPACE, CATALOG_ROOT_ID, [rawFormatter("f1", "House style")]), "shared");
    expect(formatter).toMatchObject({ kind: "formatter", name: "House style", materialCount: 1 });
    expect(formatter.steps).toEqual([]);   // a formatter carries a spec Material, not ordered steps
  });

  it("takes multiple authored formatters WHOLE while scraping a subject source for routines only", () => {
    // The seed's shared shape: subject sources scraped for routines + formatters as `authored`.
    const entries = listCatalogEntries(
      assembleCatalog([rawSource], SHARED_CATALOG_NAMESPACE, CATALOG_ROOT_ID, [rawFormatter("f1", "House style"), rawFormatter("f2", "Art style")]),
      "shared",
    );
    expect(entries.filter((e) => e.kind === "routine").map((e) => e.id)).toEqual(["r-entry"]);
    expect(entries.filter((e) => e.kind === "formatter").map((e) => e.name).sort()).toEqual(["Art style", "House style"]);
  });

  it("seeds a WORKSPACE catalog from an authored formatter, tagged with that scope", () => {
    const [formatter] = listCatalogEntries(assembleCatalog([], catalogNamespace("senegal"), CATALOG_ROOT_ID, [rawFormatter("fmt", "Maths illustration layout")]), "workspace");
    expect(formatter).toMatchObject({ kind: "formatter", scope: "workspace", name: "Maths illustration layout", materialCount: 1 });
    expect(formatter.steps).toEqual([]);
  });

  it("does NOT scrape a formatter a subject graph carries (attached via use_formatter) into the catalog", () => {
    // A subject bundle may hold a formatter COPY (top-level InstructionalRoutine with
    // catalogKind:formatter, linked to its Course by usesRoutine). Scraping the bundle for
    // routines must skip it — otherwise re-exporting attachments into sources/ would
    // double-seed the catalog. Only the real routine survives as an entry.
    const bundleWithAttachedFormatter: RawGraphSnapshot = {
      nodes: [
        { id: "r-entry", labels: ["InstructionalRoutine"], properties: { description: "Fiche", metadata: { role: "instructional-routine" } } },
        { id: "r-m1", labels: ["Material"], properties: { content: "..." } },
        { id: "fmt", labels: ["InstructionalRoutine"], properties: { description: "MOHEBS house style (docx)", metadata: { role: "instructional-routine", catalogKind: "formatter" } } },
        { id: "fmt-spec", labels: ["Material"], properties: { content: "..." } },
        { id: "course", labels: ["Course"], properties: { description: "Outil de l'élève" } },
      ],
      relationships: [
        { id: "e1", type: "hasPart", start: "r-entry", end: "r-m1", properties: {} },
        { id: "e2", type: "hasPart", start: "fmt", end: "fmt-spec", properties: {} },
        { id: "e3", type: "usesRoutine", start: "course", end: "fmt", properties: {} },
      ],
    };
    const entries = listCatalogEntries(assembleCatalog([bundleWithAttachedFormatter]), "shared");
    expect(entries.map((e) => e.id)).toEqual(["r-entry"]);   // the formatter copy is skipped
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
