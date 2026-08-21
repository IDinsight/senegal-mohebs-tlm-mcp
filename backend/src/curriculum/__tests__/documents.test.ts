/*
 * documentSubgraph — the generic TLM (document) reader. Rooted at a
 * TeachingLearningMaterial, it resolves the three things generation composes: the
 * document's assemblyGuide, its Formatter/FormatterSpec rendering stack, and the
 * curriculum to render (a DocumentSection spine when present, else the covered
 * Course). The fixtures carry no document layer yet (that is the phase-4 data
 * migration), so this builds a synthetic graph exercising both resolution paths —
 * and proves formatting/routines never leak into the curriculum walk.
 */
import { describe, it, expect } from "vitest";
import { documentSubgraph, type DocumentScope } from "../documents.js";
import type { CurriculumModel, RawGraphSnapshot } from "../../types.js";

type N = RawGraphSnapshot["nodes"][number];
type E = RawGraphSnapshot["relationships"][number];

const node = (id: string, labels: string[], properties: Record<string, unknown> = {}): N => ({ id, labels, properties });
const edge = (type: string, start: string, end: string): E => ({ id: `${type}:${start}->${end}`, type, start, end, properties: {} });

// One graph holding TWO documents over a shared little curriculum:
//   • tlm-manual — a DocumentSection spine (front-matter cover + one section per lesson)
//   • tlm-guide  — no spine; the simple TLM→covers→Course fallback
// The curriculum (Course → chapter → 2 lessons) also carries an alignment edge and
// a usesRoutine formatter-routine — neither of which the curriculum walk should follow.
const NODES: N[] = [
  // curriculum
  node("crs", ["Course"], { description: "Cours" }),
  node("chap", ["LessonGrouping"], { groupName: "Chapitre", description: "Chapitre 1" }),
  node("les-1", ["Lesson"], { position: 1, description: "Leçon 1" }),
  node("les-2", ["Lesson"], { position: 2, description: "Leçon 2" }),
  node("sfi", ["StandardsFrameworkItem"], { statementType: "Objectif spécifique", description: "OS" }),
  node("routine", ["InstructionalRoutine"], { description: "vieux formateur" }),
  // document A: tlm-manual with a section spine
  node("tlm-manual", ["TeachingLearningMaterial"], { title: "Manuel de l'élève", metadata: { assemblyGuide: "Une page par leçon." } }),
  node("sec-cover", ["DocumentSection"], { position: 0, description: "Couverture" }),   // front-matter, no covers
  node("sec-1", ["DocumentSection"], { position: 1, description: "Section leçon 1" }),
  node("sec-2", ["DocumentSection"], { position: 2, description: "Section leçon 2" }),
  node("fmt-art", ["Formatter"], { description: "Style illustration" }),               // doc-wide formatter
  node("spec-art", ["FormatterSpec"], { content: "Aquarelle." }),
  node("fmt-sec", ["Formatter"], { description: "Mise en page section" }),             // per-section formatter
  node("spec-sec", ["FormatterSpec"], { content: "Deux colonnes." }),
  // document B: tlm-guide, no spine — covers the Course directly
  node("tlm-guide", ["TeachingLearningMaterial"], { title: "Guide de l'enseignant" }),
  node("fmt-guide", ["Formatter"], { description: "Style guide" }),
  // document C: a TLM that covers nothing yet
  node("tlm-empty", ["TeachingLearningMaterial"], { title: "Brouillon" }),
];

const EDGES: E[] = [
  // curriculum containment + the two edges the walk must NOT follow
  edge("hasPart", "crs", "chap"),
  edge("hasPart", "chap", "les-1"),
  edge("hasPart", "chap", "les-2"),
  edge("hasEducationalAlignment", "les-1", "sfi"),   // alignment — not followed
  edge("usesRoutine", "les-1", "routine"),           // formatter-as-routine — not followed
  // document A spine + rendering stack
  edge("covers", "tlm-manual", "crs"),               // coarse hint (sections win over it)
  edge("hasPart", "tlm-manual", "sec-cover"),
  edge("hasPart", "tlm-manual", "sec-1"),
  edge("hasPart", "tlm-manual", "sec-2"),
  edge("hasPart", "tlm-manual", "fmt-art"),
  edge("hasPart", "fmt-art", "spec-art"),
  edge("covers", "sec-1", "les-1"),
  edge("covers", "sec-2", "les-2"),
  edge("hasPart", "sec-1", "fmt-sec"),
  edge("hasPart", "fmt-sec", "spec-sec"),
  // document B: covers the Course, one doc-wide formatter, no sections
  edge("covers", "tlm-guide", "crs"),
  edge("hasPart", "tlm-guide", "fmt-guide"),
];

const model = { rawGraph: { nodes: NODES, relationships: EDGES } } as CurriculumModel;
const ids = (ns: { id: string }[]) => new Set(ns.map((n) => n.id));

// These fixtures always fit the budget, so `curriculum` is inlined; narrow the
// self-bounding union to the { nodes, edges } branch for the assertions below.
const inlined = (c: DocumentScope["curriculum"]) => {
  if ("tooLarge" in c) throw new Error("fixture curriculum unexpectedly self-bounded");
  return c;
};

describe("documentSubgraph — the section-spine document", () => {
  const doc = documentSubgraph(model, "tlm-manual")!;

  it("resolves the curriculum from the section spine and reads the assembly guide", () => {
    expect(doc).not.toBeNull();
    expect(doc.scope).toBe("sections");
    expect(doc.assemblyGuide).toBe("Une page par leçon.");
  });

  it("returns the sections ordered by position, front-matter carrying no covers target", () => {
    expect(doc.sections.map((s) => s.id)).toEqual(["sec-cover", "sec-1", "sec-2"]);
    expect(doc.sections[0].covers).toEqual([]);          // the cover is front-matter
    expect(doc.sections[1].covers).toEqual(["les-1"]);
    expect(doc.sections[2].covers).toEqual(["les-2"]);
  });

  it("includes the whole rendering stack (doc-wide + per-section) in the document subtree", () => {
    const docIds = ids(doc.document.nodes);
    for (const id of ["tlm-manual", "sec-cover", "sec-1", "sec-2", "fmt-art", "spec-art", "fmt-sec", "spec-sec"]) {
      expect(docIds.has(id)).toBe(true);
    }
    // covers edges ride the document subtree on their own axis (section→lesson + the coarse TLM→course hint).
    expect(doc.document.edges.some((e) => e.type === "covers" && e.start === "sec-1" && e.end === "les-1")).toBe(true);
    expect(doc.document.edges.some((e) => e.type === "covers" && e.start === "tlm-manual" && e.end === "crs")).toBe(true);
  });

  it("renders exactly the covered lessons — no formatter and no routine leak into the curriculum", () => {
    expect(ids(inlined(doc.curriculum).nodes)).toEqual(new Set(["les-1", "les-2"]));
    // the alignment target and the usesRoutine formatter are reachable in the graph
    // but the curriculum walk (hasPart/hasChild only) must exclude both.
    const curIds = ids(inlined(doc.curriculum).nodes);
    expect(curIds.has("sfi")).toBe(false);
    expect(curIds.has("routine")).toBe(false);
    expect(curIds.has("fmt-art")).toBe(false);
  });
});

describe("documentSubgraph — the covers-only document (Course fallback)", () => {
  const doc = documentSubgraph(model, "tlm-guide")!;

  it("falls back to the covered Course when there is no section spine", () => {
    expect(doc.scope).toBe("course");
    expect(doc.sections).toEqual([]);
    expect(doc.assemblyGuide).toBeNull();
  });

  it("walks the Course containment subtree, still excluding the routine and the SFI", () => {
    expect(ids(inlined(doc.curriculum).nodes)).toEqual(new Set(["crs", "chap", "les-1", "les-2"]));
  });

  it("carries only its own doc-wide formatter in the document subtree", () => {
    const docIds = ids(doc.document.nodes);
    expect(docIds.has("fmt-guide")).toBe(true);
    expect(docIds.has("fmt-art")).toBe(false);   // the other document's formatter stays out
  });
});

describe("documentSubgraph — edge cases", () => {
  it("scope is 'none' with an empty curriculum when the TLM covers nothing", () => {
    const doc = documentSubgraph(model, "tlm-empty")!;
    expect(doc.scope).toBe("none");
    expect(inlined(doc.curriculum).nodes).toEqual([]);
    expect(doc.sections).toEqual([]);
  });

  it("returns null for a non-TLM id and an unknown id", () => {
    expect(documentSubgraph(model, "les-1")).toBeNull();
    expect(documentSubgraph(model, "no-such-id")).toBeNull();
  });
});
