/*
 * lessonSubgraph — the per-lesson generation reader. Rooted at one Lesson, it
 * resolves the lesson's own content, the routine that APPLIES (nearest-wins: the
 * lesson's own usesRoutine, else the nearest ancestor's — the Course default), and
 * the formatters of every document that covers the lesson. The fixtures carry no
 * document layer, so this builds a synthetic graph shaped like ci/maths after the
 * routine-collapse: a Course carrying ONE usesRoutine, weeks + chapter over the
 * lessons (a lesson reachable by both hasChild-week and hasPart-chapter), and two
 * TLMs covering the Course.
 */
import { describe, it, expect } from "vitest";
import { lessonSubgraph } from "../lesson.js";
import type { CurriculumModel, RawGraphSnapshot } from "../../types.js";

type N = RawGraphSnapshot["nodes"][number];
type E = RawGraphSnapshot["relationships"][number];

const node = (id: string, labels: string[], properties: Record<string, unknown> = {}): N => ({ id, labels, properties });
const edge = (type: string, start: string, end: string): E => ({ id: `${type}:${start}->${end}`, type, start, end, properties: {} });

// Course → chapter → 2 lessons, and Course → week → the same lessons (the maths
// two-parent shape: chapter via hasPart, week via hasChild). The Course carries the
// one shared routine; lesson-2 overrides it with its own. Two documents cover the
// Course, each with its own formatter stack.
const NODES: N[] = [
  node("crs", ["Course"], { description: "Cours" }),
  node("chap", ["LessonGrouping"], { groupName: "Chapitre", description: "Chapitre 1" }),
  node("week", ["LessonGrouping"], { groupName: "Semaine", description: "Semaine 1" }),
  node("les-1", ["Lesson"], { position: 1, description: "Leçon ordinaire" }),
  node("les-2", ["Lesson"], { position: 2, description: "Leçon avec routine propre" }),
  node("act-1", ["Activity"], { description: "Tâche de la leçon 1" }),
  node("mat-1", ["Material"], { content: "Ardoise" }),
  // routines: the Course default (Fiche) + a lesson-2 override
  node("fiche", ["InstructionalRoutine"], { description: "Fiche de leçon — enseignement explicite" }),
  node("fiche-step", ["InstructionalRoutine"], { description: "JE FAIS" }),
  node("override", ["InstructionalRoutine"], { description: "Routine bilan" }),
  // documents: two TLMs, each covering the Course, each with its own formatter
  node("tlm-guide", ["TeachingLearningMaterial"], { title: "Guide de l'enseignant" }),
  node("fmt-guide", ["Formatter"], { description: "Style guide" }),
  node("spec-guide", ["FormatterSpec"], { content: "Deux colonnes." }),
  node("tlm-manual", ["TeachingLearningMaterial"], { title: "Manuel de l'élève" }),
  node("fmt-manual", ["Formatter"], { description: "Style illustration" }),
];

const EDGES: E[] = [
  // content nesting (hasPart) + schedule axis (hasChild) — a lesson has both parents
  edge("hasPart", "crs", "chap"),
  edge("hasPart", "chap", "les-1"),
  edge("hasPart", "chap", "les-2"),
  edge("hasChild", "crs", "week"),
  edge("hasChild", "week", "les-1"),
  edge("hasChild", "week", "les-2"),
  edge("hasPart", "les-1", "act-1"),
  edge("hasPart", "act-1", "mat-1"),
  // routines: Course default for everyone, lesson-2 overrides
  edge("usesRoutine", "crs", "fiche"),
  edge("hasPart", "fiche", "fiche-step"),
  edge("usesRoutine", "les-2", "override"),
  // documents cover the Course; formatters hang under each TLM
  edge("covers", "tlm-guide", "crs"),
  edge("hasPart", "tlm-guide", "fmt-guide"),
  edge("hasPart", "fmt-guide", "spec-guide"),
  edge("covers", "tlm-manual", "crs"),
  edge("hasPart", "tlm-manual", "fmt-manual"),
];

const model = { rawGraph: { nodes: NODES, relationships: EDGES } } as CurriculumModel;
const ids = (list: { id: string }[]) => new Set(list.map((item) => item.id));

describe("lessonSubgraph — a lesson inheriting the Course routine", () => {
  const scope = lessonSubgraph(model, "les-1")!;

  it("returns the lesson's own content subtree (hasPart down)", () => {
    expect(scope).not.toBeNull();
    expect(ids(scope.content.nodes)).toEqual(new Set(["les-1", "act-1", "mat-1"]));
  });

  it("inherits the Course's routine when the lesson has none of its own", () => {
    expect(scope.routine).not.toBeNull();
    expect(scope.routine!.entryId).toBe("fiche");
    expect(scope.routine!.resolvedFrom).toBe("crs");
    expect(scope.routine!.inherited).toBe(true);
    // the routine subtree carries its steps
    expect(ids(scope.routine!.nodes)).toEqual(new Set(["fiche", "fiche-step"]));
  });

  it("pulls formatters from every document that covers the lesson's Course", () => {
    const byTlm = new Map(scope.formatters.map((entry) => [entry.tlm, entry]));
    expect(new Set(byTlm.keys())).toEqual(new Set(["tlm-guide", "tlm-manual"]));
    expect(ids(byTlm.get("tlm-guide")!.nodes)).toEqual(new Set(["fmt-guide", "spec-guide"]));
    expect(ids(byTlm.get("tlm-manual")!.nodes)).toEqual(new Set(["fmt-manual"]));
    expect(byTlm.get("tlm-guide")!.via).toBe("crs");
  });
});

describe("lessonSubgraph — a lesson with its own routine (override wins)", () => {
  const scope = lessonSubgraph(model, "les-2")!;

  it("uses the lesson's own routine, not the Course default", () => {
    expect(scope.routine!.entryId).toBe("override");
    expect(scope.routine!.resolvedFrom).toBe("les-2");
    expect(scope.routine!.inherited).toBe(false);
  });
});

describe("lessonSubgraph — formatter scoping and edge cases", () => {
  it("scopes formatters to one document when tlmId is given", () => {
    const scope = lessonSubgraph(model, "les-1", "tlm-guide")!;
    expect(scope.formatters.map((entry) => entry.tlm)).toEqual(["tlm-guide"]);
  });

  it("returns a null routine when nothing in the ancestry uses one", () => {
    // A lesson hung directly under a routine-less root has no routine to resolve.
    const orphanNodes: N[] = [
      node("root", ["LessonGrouping"], { groupName: "Chapitre" }),
      node("les-orphan", ["Lesson"], { position: 1 }),
    ];
    const orphanEdges: E[] = [edge("hasPart", "root", "les-orphan")];
    const orphanModel = { rawGraph: { nodes: orphanNodes, relationships: orphanEdges } } as CurriculumModel;

    const scope = lessonSubgraph(orphanModel, "les-orphan")!;
    expect(scope.routine).toBeNull();
    expect(scope.formatters).toEqual([]);
  });

  it("returns null for a non-Lesson id and an unknown id", () => {
    expect(lessonSubgraph(model, "crs")).toBeNull();
    expect(lessonSubgraph(model, "no-such-id")).toBeNull();
  });
});
