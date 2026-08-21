/*
 * documentSectionSubgraph — the per-section generation reader. Anchored on ONE
 * DocumentSection (the node that already IS the document↔curriculum binding), it
 * resolves the owning document, the curriculum the section renders, the routine
 * that APPLIES (nearest-wins, document-first: the section's own usesRoutine, else
 * the owning TLM's, else the covered curriculum's ancestry), and the formatters
 * (the TLM's doc-wide stack ∪ the section's own — sibling sections excluded).
 *
 * Two synthetic graphs: model A gives the TLM NO routine, so a routine-less section
 * falls through to the covered Course's routine (curriculum tier); model B adds a
 * TLM routine to prove the document tier wins over that Course default.
 */
import { describe, it, expect } from "vitest";
import { documentSectionSubgraph } from "../documents.js";
import type { CurriculumModel, RawGraphSnapshot } from "../../types.js";

type N = RawGraphSnapshot["nodes"][number];
type E = RawGraphSnapshot["relationships"][number];

const node = (id: string, labels: string[], properties: Record<string, unknown> = {}): N => ({ id, labels, properties });
const edge = (type: string, start: string, end: string): E => ({ id: `${type}:${start}->${end}`, type, start, end, properties: {} });
const ids = (list: { id: string }[]) => new Set(list.map((item) => item.id));

// Curriculum: a Course (carrying one default routine) → chapter → two lessons.
const CURRICULUM: N[] = [
  node("crs", ["Course"], { description: "Cours" }),
  node("chap", ["LessonGrouping"], { groupName: "Chapitre", description: "Chapitre 1" }),
  node("les-1", ["Lesson"], { position: 1, description: "Leçon 1" }),
  node("les-2", ["Lesson"], { position: 2, description: "Leçon 2" }),
  node("act-1", ["Activity"], { description: "Tâche de la leçon 1" }),
  node("crs-routine", ["InstructionalRoutine"], { description: "Fiche par défaut du cours" }),
  node("crs-step", ["InstructionalRoutine"], { description: "JE FAIS" }),
];
const CURRICULUM_EDGES: E[] = [
  edge("hasPart", "crs", "chap"),
  edge("hasPart", "chap", "les-1"),
  edge("hasPart", "chap", "les-2"),
  edge("hasPart", "les-1", "act-1"),
  edge("usesRoutine", "crs", "crs-routine"),
  edge("hasPart", "crs-routine", "crs-step"),
];

// Document: one TLM with a doc-wide formatter stack + three sections. sec-1 covers
// les-1 and has its OWN per-section formatter; sec-2 covers les-2 and carries its
// OWN routine; sec-front covers nothing (front-matter) and hangs a sibling formatter
// that must NOT leak into other sections' stacks.
const DOCUMENT: N[] = [
  node("tlm", ["TeachingLearningMaterial"], { title: "Guide", metadata: { assemblyGuide: "Une leçon par page." } }),
  node("fmt-doc", ["Formatter"], { description: "Style du document" }),
  node("spec-doc", ["FormatterSpec"], { content: "Deux colonnes." }),
  node("sec-1", ["DocumentSection"], { position: 1, description: "Fiche leçon 1" }),
  node("fmt-sec", ["Formatter"], { description: "Encart propre à la section 1" }),
  node("sec-2", ["DocumentSection"], { position: 2, description: "Fiche leçon 2" }),
  node("sec-routine", ["InstructionalRoutine"], { description: "Routine propre à la section 2" }),
  node("sec-front", ["DocumentSection"], { position: 0, description: "Page de garde" }),
  node("fmt-sib", ["Formatter"], { description: "Encart d'une section sœur" }),
];
const DOCUMENT_EDGES: E[] = [
  edge("hasPart", "tlm", "fmt-doc"),
  edge("hasPart", "fmt-doc", "spec-doc"),
  edge("hasPart", "tlm", "sec-1"),
  edge("hasPart", "sec-1", "fmt-sec"),
  edge("covers", "sec-1", "les-1"),
  edge("hasPart", "tlm", "sec-2"),
  edge("hasPart", "sec-2", "sec-routine"),
  edge("usesRoutine", "sec-2", "sec-routine"),
  edge("covers", "sec-2", "les-2"),
  edge("hasPart", "tlm", "sec-front"),
  edge("hasPart", "sec-front", "fmt-sib"),
];

const modelA = {
  rawGraph: { nodes: [...CURRICULUM, ...DOCUMENT], relationships: [...CURRICULUM_EDGES, ...DOCUMENT_EDGES] },
} as CurriculumModel;

describe("documentSectionSubgraph — a lesson section inheriting the Course routine", () => {
  const scope = documentSectionSubgraph(modelA, "sec-1")!;

  it("resolves the owning document (nearest TLM up hasPart) with its assembly guide", () => {
    expect(scope.document).not.toBeNull();
    expect(scope.document!.id).toBe("tlm");
    expect(scope.document!.assemblyGuide).toBe("Une leçon par page.");
  });

  it("renders the covered lesson's pure containment subtree", () => {
    expect(scope.covers).toEqual(["les-1"]);
    expect(ids(scope.curriculum.nodes)).toEqual(new Set(["les-1", "act-1"]));
  });

  it("falls through to the covered Course's routine (curriculum tier) when neither the section nor the TLM carries one", () => {
    expect(scope.routine).not.toBeNull();
    expect(scope.routine!.entryId).toBe("crs-routine");
    expect(scope.routine!.resolvedFrom).toBe("crs");
    expect(scope.routine!.resolvedFromScope).toBe("curriculum");
    expect(ids(scope.routine!.nodes)).toEqual(new Set(["crs-routine", "crs-step"]));
  });

  it("unions the TLM's doc-wide stack with the section's own formatters, excluding sibling sections", () => {
    expect(ids(scope.formatters.nodes)).toEqual(new Set(["fmt-doc", "spec-doc", "fmt-sec"]));
  });
});

describe("documentSectionSubgraph — a section with its own routine (section tier wins)", () => {
  const scope = documentSectionSubgraph(modelA, "sec-2")!;

  it("uses the section's own routine over the Course default", () => {
    expect(scope.routine!.entryId).toBe("sec-routine");
    expect(scope.routine!.resolvedFrom).toBe("sec-2");
    expect(scope.routine!.resolvedFromScope).toBe("section");
  });
});

describe("documentSectionSubgraph — a front-matter section (empty covers)", () => {
  const scope = documentSectionSubgraph(modelA, "sec-front")!;

  it("covers nothing and renders no curriculum, but still resolves its document + formatters", () => {
    expect(scope.covers).toEqual([]);
    expect(scope.curriculum.nodes).toEqual([]);
    expect(scope.document!.id).toBe("tlm");
    // no covers ⇒ no curriculum ancestry, and neither section nor TLM has a routine
    expect(scope.routine).toBeNull();
    // the doc-wide stack still applies; this section's own sibling formatter joins it
    expect(ids(scope.formatters.nodes)).toEqual(new Set(["fmt-doc", "spec-doc", "fmt-sib"]));
  });
});

describe("documentSectionSubgraph — the document tier wins over the Course default", () => {
  // Same graph, but the TLM now carries its own routine: a routine-less section must
  // resolve to it (document tier) rather than fall through to the Course (curriculum).
  const modelB = {
    rawGraph: {
      nodes: [...CURRICULUM, ...DOCUMENT, node("tlm-routine", ["InstructionalRoutine"], { description: "Routine du document" })],
      relationships: [...CURRICULUM_EDGES, ...DOCUMENT_EDGES, edge("usesRoutine", "tlm", "tlm-routine")],
    },
  } as CurriculumModel;

  it("resolves sec-1's routine from the owning TLM, not the covered Course", () => {
    const scope = documentSectionSubgraph(modelB, "sec-1")!;
    expect(scope.routine!.entryId).toBe("tlm-routine");
    expect(scope.routine!.resolvedFrom).toBe("tlm");
    expect(scope.routine!.resolvedFromScope).toBe("document");
  });
});

describe("documentSectionSubgraph — edge cases", () => {
  it("returns null for a non-DocumentSection id and an unknown id", () => {
    expect(documentSectionSubgraph(modelA, "tlm")).toBeNull();
    expect(documentSectionSubgraph(modelA, "les-1")).toBeNull();
    expect(documentSectionSubgraph(modelA, "no-such-id")).toBeNull();
  });

  it("returns a null document when the section is not under any TLM", () => {
    const orphan = {
      rawGraph: {
        nodes: [node("lone-sec", ["DocumentSection"], { position: 1 })],
        relationships: [] as E[],
      },
    } as CurriculumModel;
    const scope = documentSectionSubgraph(orphan, "lone-sec")!;
    expect(scope.document).toBeNull();
    expect(scope.routine).toBeNull();
    expect(scope.formatters.nodes).toEqual([]);
  });
});
