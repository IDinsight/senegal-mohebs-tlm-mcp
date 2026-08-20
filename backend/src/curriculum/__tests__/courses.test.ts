/*
 * Generic Course readers (coursesOf / courseSubgraph) — they surface raw LC
 * nodes with no projection. Exercised against the CI maths bundle (the one
 * subject with real Course nodes) and a subject with none.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { coursesOf, courseSubgraph, standardsFor } from "../courses.js";

const modelFor = (grade: string, subject: string) => {
  const raw = JSON.parse(readFileSync(resolve(subjectDir("senegal", grade, subject), KG_FIXTURE), "utf8"));
  return resolveAdapter("senegal", grade, subject)!.parse(raw);
};

describe("coursesOf / courseSubgraph — generic Course readers", () => {
  it("lists the maths Course nodes as raw LC nodes", () => {
    const courses = coursesOf(modelFor("ci", "maths"));
    expect(courses).toHaveLength(2);
    expect(courses.every((course) => course.labels.includes("Course"))).toBe(true);
    const titles = courses.map((course) => course.properties.description);
    expect(titles).toContain("Outil de l'élève");
    expect(titles).toContain("Guide de l'enseignant");
  });

  it("returns the containment subtree under a course, with edges among its nodes", () => {
    const model = modelFor("ci", "maths");
    const student = coursesOf(model).find((course) => course.properties.description === "Outil de l'élève")!;
    const subgraph = courseSubgraph(model, student.id)!;
    expect(subgraph).not.toBeNull();
    expect(subgraph.course).toBe(student.id);

    // the course itself + its 25 chapter LessonGroupings (at least) are present
    expect(subgraph.nodes.some((node) => node.id === student.id)).toBe(true);
    const groupings = subgraph.nodes.filter((node) => node.labels.includes("LessonGrouping"));
    expect(groupings.length).toBeGreaterThanOrEqual(25);

    // every returned edge connects two returned nodes (self-contained subgraph)
    const ids = new Set(subgraph.nodes.map((node) => node.id));
    expect(subgraph.edges.every((edge) => ids.has(edge.start) && ids.has(edge.end))).toBe(true);
  });

  it("does NOT follow usesRoutine — formatters/routines reach generation via the TLM, not the Course", () => {
    const model = modelFor("ci", "maths");
    const student = coursesOf(model).find((course) => course.properties.description === "Outil de l'élève")!;

    // Sanity: the fixture still has usesRoutine edges pointing OUT of this Course,
    // so "the walk doesn't follow them" is a real assertion, not a vacuous one.
    const usesRoutineOutOfCourse = model.rawGraph!.relationships.filter(
      (edge) => edge.type === "usesRoutine" && edge.start === student.id,
    );
    expect(usesRoutineOutOfCourse.length).toBeGreaterThan(0);

    const subgraph = courseSubgraph(model, student.id)!;
    // The Course subtree is pure containment: no formatter/routine node comes in,
    // and no usesRoutine edge survives inside it (Phase 4 — those hang off the TLM).
    expect(subgraph.nodes.some((node) => node.labels.includes("InstructionalRoutine"))).toBe(false);
    expect(subgraph.nodes.some((node) => node.labels.includes("Formatter"))).toBe(false);
    expect(subgraph.edges.some((edge) => edge.type === "usesRoutine")).toBe(false);
  });

  it("returns null for a non-Course id and an unknown id", () => {
    const model = modelFor("ci", "maths");
    const someLesson = model.rawGraph!.nodes.find((node) => (node.labels ?? []).includes("Lesson"))!;
    expect(courseSubgraph(model, someLesson.id)).toBeNull();
    expect(courseSubgraph(model, "no-such-id")).toBeNull();
  });

  it("returns [] for a subject whose graph has no Course node", () => {
    expect(coursesOf(modelFor("ce1", "reading"))).toEqual([]);
  });

  it("standardsFor reaches the spine from a lesson: the aligned SFI + its components + illustrative activities", () => {
    const model = modelFor("ci", "maths");
    // a teacher-guide lesson that aligns to an OS (student-book lessons don't yet)
    const aligned = new Set(model.rawGraph!.relationships.filter((edge) => edge.type === "hasEducationalAlignment").map((edge) => edge.start));
    const lesson = model.rawGraph!.nodes.find((node) => (node.labels ?? []).includes("Lesson") && aligned.has(node.id))!;
    const standards = standardsFor(model, lesson.id)!;
    expect(standards.node).toBe(lesson.id);
    expect(standards.nodes.some((node) => node.labels.includes("StandardsFrameworkItem"))).toBe(true);
    expect(standards.edges.some((edge) => edge.type === "hasEducationalAlignment" && edge.start === lesson.id)).toBe(true);
    // bounded — a single lesson's neighborhood, not the whole spine
    expect(standards.nodes.length).toBeLessThan(30);
  });

  it("standardsFor returns empty nodes for a node wired to no standard (the placeholder student book)", () => {
    const model = modelFor("ci", "maths");
    const aligned = new Set(model.rawGraph!.relationships.filter((edge) => edge.type === "hasEducationalAlignment").map((edge) => edge.start));
    const placeholder = model.rawGraph!.nodes.find(
      (node) => (node.labels ?? []).includes("Lesson") && (node.properties?.metadata as { role?: string })?.role === "studentBookLesson" && !aligned.has(node.id),
    )!;
    expect(standardsFor(model, placeholder.id)!.nodes).toEqual([]);
    expect(standardsFor(model, "no-such-id")).toBeNull();
  });
});
