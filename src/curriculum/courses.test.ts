/*
 * Generic Course readers (list_courses / get_course) — they surface raw LC
 * nodes with no projection. Exercised against the CI maths bundle (the one
 * subject with real Course nodes) and a subject with none.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { CONFIG } from "../config.js";
import { subjectDir } from "../context/index.js";
import { resolveAdapter } from "../adapters/index.js";
import { coursesOf, courseSubgraph, standardsFor } from "./courses.js";

const modelFor = (grade: string, subject: string) => {
  const raw = JSON.parse(readFileSync(resolve(subjectDir("senegal", grade, subject), CONFIG.kgFile), "utf8"));
  return resolveAdapter(grade, subject)!.parse(raw);
};

describe("coursesOf / courseSubgraph — generic Course readers", () => {
  it("lists the maths Course nodes as raw LC nodes", () => {
    const courses = coursesOf(modelFor("ci", "maths"));
    expect(courses).toHaveLength(2);
    expect(courses.every((c) => c.labels.includes("Course"))).toBe(true);
    const titles = courses.map((c) => c.properties.description);
    expect(titles).toContain("Outil de l'élève");
    expect(titles).toContain("Guide de l'enseignant");
  });

  it("returns the containment subtree under a course, with edges among its nodes", () => {
    const model = modelFor("ci", "maths");
    const student = coursesOf(model).find((c) => c.properties.description === "Outil de l'élève")!;
    const sub = courseSubgraph(model, student.id)!;
    expect(sub).not.toBeNull();
    expect(sub.course).toBe(student.id);
    // the course itself + its 25 chapter LessonGroupings (at least) are present
    expect(sub.nodes.some((n) => n.id === student.id)).toBe(true);
    const groupings = sub.nodes.filter((n) => n.labels.includes("LessonGrouping"));
    expect(groupings.length).toBeGreaterThanOrEqual(25);
    // every returned edge connects two returned nodes (self-contained subgraph)
    const ids = new Set(sub.nodes.map((n) => n.id));
    expect(sub.edges.every((e) => ids.has(e.start) && ids.has(e.end))).toBe(true);
  });

  it("pulls in the InstructionalRoutine a lesson applies (usesRoutine) and its step Materials", () => {
    const model = modelFor("ci", "maths");
    const student = coursesOf(model).find((c) => c.properties.description === "Outil de l'élève")!;
    const sub = courseSubgraph(model, student.id)!;
    // The student book's container lessons usesRoutine the pupil-manual routine,
    // so its InstructionalRoutine tree + the step Materials come along.
    expect(sub.nodes.some((n) => n.labels.includes("InstructionalRoutine"))).toBe(true);
    expect(sub.nodes.some((n) => n.labels.includes("Material"))).toBe(true);
    expect(sub.edges.some((e) => e.type === "usesRoutine")).toBe(true);
  });

  it("returns null for a non-Course id and an unknown id", () => {
    const model = modelFor("ci", "maths");
    const someLesson = model.rawGraph!.nodes.find((n) => (n.labels ?? []).includes("Lesson"))!;
    expect(courseSubgraph(model, someLesson.id)).toBeNull();
    expect(courseSubgraph(model, "no-such-id")).toBeNull();
  });

  it("returns [] for a subject whose graph has no Course node", () => {
    expect(coursesOf(modelFor("ce1", "reading"))).toEqual([]);
  });

  it("standardsFor reaches the spine from a lesson: the aligned SFI + its components + illustrative activities", () => {
    const model = modelFor("ci", "maths");
    // a teacher-guide lesson that aligns to an OS (student-book lessons don't yet)
    const aligned = new Set(model.rawGraph!.relationships.filter((e) => e.type === "hasEducationalAlignment").map((e) => e.start));
    const lesson = model.rawGraph!.nodes.find((n) => (n.labels ?? []).includes("Lesson") && aligned.has(n.id))!;
    const s = standardsFor(model, lesson.id)!;
    expect(s.node).toBe(lesson.id);
    expect(s.nodes.some((n) => n.labels.includes("StandardsFrameworkItem"))).toBe(true);
    expect(s.edges.some((e) => e.type === "hasEducationalAlignment" && e.start === lesson.id)).toBe(true);
    // bounded — a single lesson's neighborhood, not the whole spine
    expect(s.nodes.length).toBeLessThan(30);
  });

  it("standardsFor returns empty nodes for a node wired to no standard (the placeholder student book)", () => {
    const model = modelFor("ci", "maths");
    const aligned = new Set(model.rawGraph!.relationships.filter((e) => e.type === "hasEducationalAlignment").map((e) => e.start));
    const placeholder = model.rawGraph!.nodes.find(
      (n) => (n.labels ?? []).includes("Lesson") && (n.properties?.metadata as { role?: string })?.role === "studentBookLesson" && !aligned.has(n.id),
    )!;
    expect(standardsFor(model, placeholder.id)!.nodes).toEqual([]);
    expect(standardsFor(model, "no-such-id")).toBeNull();
  });
});
