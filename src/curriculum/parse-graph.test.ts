// Proves ONE generic parser serves both subjects: parse each real source graph
// with its descriptor and assert the resulting CurriculumModel has the right
// spine shape (kinds, counts, and edge-derived parent/child links). This is the
// 2a checkpoint — the parser is validated before any adapter is wired to it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parseGraph, type GraphParseDescriptor } from "./parse-graph.js";
import type { CurriculumModel, CurriculumUnit } from "../types.js";

const load = (rel: string) => JSON.parse(readFileSync(resolve(rel), "utf8"));

// Descriptors mirror what the adapters will declare in the next step.
const MATHS: GraphParseDescriptor = {
  roleToKind: {
    week: "week",
    subtopic: "chapter",
    strand: "domaine",
    expectation: "lesson",
    "intégration du palier": "lesson",
  },
  labelToKind: { LearningComponent: "component", Curriculum: "task" },
  numberFrom: "order",
  progressionEdge: "buildsTowards",
};

const READING: GraphParseDescriptor = {
  roleToKind: { week: "week", expectation: "standard" },
  labelToKind: { LearningComponent: "component" },
  numberFrom: "description",
};

const kindCounts = (m: CurriculumModel, kinds: string[]) =>
  Object.fromEntries(kinds.map((k) => [k, m.unitsOfKind(k).length]));

describe("generic parseGraph — maths (new shape)", () => {
  const m = parseGraph(load("sources/ci/maths/knowledge_graph.json"), MATHS);

  it("classifies the maths spine by metadata.role + label", () => {
    expect(kindCounts(m, ["week", "chapter", "domaine", "lesson"])).toEqual({
      week: 23, chapter: 25, domaine: 4, lesson: 112,
    });
    // components/tasks exist (incl. out-of-spine ones, matching legacy parse)
    expect(m.unitsOfKind("component").length).toBeGreaterThan(0);
    expect(m.unitsOfKind("task").length).toBeGreaterThan(0);
  });

  it("links chapter→lesson via the content edge (not a number join)", () => {
    const chapters = m.unitsOfKind("chapter");
    for (const c of chapters) {
      const lessons = m.childrenOf(c.id).filter((u) => u.kind === "lesson");
      expect(lessons.length).toBeGreaterThan(0); // every chapter has lessons
    }
    // total chapter→lesson content links = 109 (3 palier-integration lessons hang off a domaine)
    const total = chapters.reduce((n, c) => n + m.childrenOf(c.id).filter((u) => u.kind === "lesson").length, 0);
    expect(total).toBe(109);
  });

  it("links week→lesson via the schedule edge, every lesson in exactly one week", () => {
    const weeks = m.unitsOfKind("week");
    const scheduled = new Set<string>();
    for (const w of weeks) for (const l of m.childrenOf(w.id)) if (l.kind === "lesson") scheduled.add(l.id);
    expect(scheduled.size).toBe(112);
  });

  it("carries the objective in text, category in statement_type, number in order", () => {
    const lesson = m.unitsOfKind("lesson").find((l) => l.code === "Leçon 15")!;
    expect(lesson.text).toContain("trouver ce qui manque");
    expect(lesson.properties.statement_type).toBe("Résolution de problème");
    expect(lesson.order).toBe(15);
    expect((lesson.properties.metadata as any).en.description).toContain("find what is missing");
  });

  it("keeps chapter progression from buildsTowards edges", () => {
    const withProg = m.unitsOfKind("chapter").filter((c) => c.buildsTowards.length > 0);
    expect(withProg.length).toBeGreaterThan(0);
  });
});

describe("generic parseGraph — reading (unchanged shape)", () => {
  const m = parseGraph(load("sources/ce1/reading/knowledge_graph.json"), READING);

  it("classifies weeks and standard leaves", () => {
    expect(m.unitsOfKind("week").length).toBeGreaterThan(0);
    expect(m.unitsOfKind("standard").length).toBeGreaterThan(0);
    expect(m.unitsOfKind("component").length).toBeGreaterThan(0);
  });

  it("derives the week number from a bare-number description", () => {
    const w = m.unitsOfKind("week").find((u) => u.order === 3)!;
    expect(w).toBeTruthy();
    expect(w.title).toBe("3");
  });

  it("attaches components to standards via supports, standards to weeks via hasChild", () => {
    const week = m.unitsOfKind("week").find((u) => u.order === 3)!;
    const standards = m.childrenOf(week.id).filter((u) => u.kind === "standard");
    expect(standards.length).toBeGreaterThan(0);
    const withComponents = standards.filter((s) => m.childrenOf(s.id).some((c) => c.kind === "component"));
    expect(withComponents.length).toBeGreaterThan(0);
  });
});
