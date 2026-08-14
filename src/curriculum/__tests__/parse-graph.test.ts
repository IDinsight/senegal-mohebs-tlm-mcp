/*
 * Proves ONE generic parser serves both subjects: parse each real source graph
 * with its descriptor and assert the resulting CurriculumModel has the right
 * spine shape (kinds, counts, and edge-derived parent/child links). This is the
 * 2a checkpoint — the parser is validated before any adapter is wired to it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parseGraph, type GraphParseDescriptor } from "../parse-graph.js";
import type { CurriculumModel, CurriculumUnit } from "../../types.js";

const load = (rel: string) => JSON.parse(readFileSync(resolve(rel), "utf8"));

// Descriptors mirror what the profiles declare. Kinds are the graph's OWN
// canonical values now — no role/label table: a LessonGrouping is named by its
// `groupName` (Chapitre/Semaine/Jour), a StandardsFrameworkItem by its
// `normalizedStatementType` (Standard / Standard Grouping), a content leaf by its
// LC label (Lesson/LearningComponent/Activity/Material).
const MATHS: GraphParseDescriptor = {
  numberFrom: "order",
  dependencyEdge: "hasDependency",
};

// Reading parsed WITHOUT its prune here, to exercise the raw parser directly (the
// prune is applied by the profile via resolvePrune; it only removes nodes, never
// changes links, so the structural assertions below hold either way).
const READING: GraphParseDescriptor = {
  numberFrom: "position",
};

const kindCounts = (model: CurriculumModel, kinds: string[]) =>
  Object.fromEntries(kinds.map((kind) => [kind, model.unitsOfKind(kind).length]));

// A standard's kind is its `statementType` (many values), so leaf standards are
// counted by their structural class: normalizedStatementType "Standard".
const leafStandards = (model: CurriculumModel): CurriculumUnit[] =>
  [...model.byId.values()].filter((u) => u.properties.normalizedStatementType === "Standard");

describe("generic parseGraph — maths (new shape)", () => {
  const model = parseGraph(load("sources/senegal/ci/maths/knowledge_graph.json"), MATHS);

  it("classifies the maths spine by its own canonical fields", () => {
    // Groupings are named by groupName (Chapitre/Semaine); lessons are `Lesson`s;
    // a standard's kind is its statementType (Arithmétique/Mesure/…, and "Domaine"
    // for the 4 strand groupings). lesson = 112 weekly + 25 Student's-Book containers.
    expect(kindCounts(model, ["Semaine", "Chapitre", "Lesson", "Domaine"])).toEqual({
      Semaine: 23, Chapitre: 25, Lesson: 137, Domaine: 4,
    });
    // 115 leaf standards (109 objectives + 3 palier + 3 interdisciplinary),
    // spread across their statementType kinds.
    expect(leafStandards(model).length).toBe(115);
    expect(model.unitsOfKind("Arithmétique").length).toBeGreaterThan(0);
    // components/tasks exist (incl. out-of-spine ones, matching legacy parse)
    expect(model.unitsOfKind("LearningComponent").length).toBeGreaterThan(0);
    expect(model.unitsOfKind("Activity").length).toBeGreaterThan(0);
  });

  it("links chapter→lesson→activity via the content tree (not a number join)", () => {
    // Canonical content nesting: chapter (LessonGrouping) ▸ Lesson ▸ Activity.
    // The weekly teaching lessons live in the Teacher's Guide (week→lesson); each
    // chapter holds ONE Student's-Book container Lesson, which holds that
    // chapter's Activities (218 total, 2 per former lesson).
    const authored = model.unitsOfKind("Chapitre").filter((chapter) => chapter.properties.groupName === "Chapitre");
    let chapterLessons = 0;
    let activities = 0;
    for (const chapter of authored) {
      const lessons = model.childrenOf(chapter.id).filter((unit) => unit.kind === "Lesson");
      expect(lessons.length).toBe(1);
      chapterLessons += lessons.length;
      for (const lesson of lessons) {
        const tasks = model.childrenOf(lesson.id).filter((unit) => unit.kind === "Activity");
        expect(tasks.length).toBeGreaterThan(0);
        activities += tasks.length;
      }
    }
    expect(chapterLessons).toBe(25);
    expect(activities).toBe(218);
  });

  it("links week→lesson via the schedule edge, every lesson in exactly one week", () => {
    const weeks = model.unitsOfKind("Semaine");
    const scheduled = new Set<string>();
    for (const week of weeks) {
      for (const lesson of model.childrenOf(week.id)) {
        if (lesson.kind === "Lesson") scheduled.add(lesson.id);
      }
    }
    expect(scheduled.size).toBe(112);
  });

  it("aligns each lesson to its standard, which carries the OS text/category/number", () => {
    // The OS (objectif spécifique) is a spine `Standard`; the Lesson `supports`
    // it (⇒ standard.childIds ∋ the Lesson).
    const standard = leafStandards(model).find((unit) => unit.code === "Leçon 15")!;
    expect(standard.text).toContain("trouver ce qui manque");
    expect(standard.properties.statementType).toBe("Résolution de problème");
    expect(standard.order).toBe(15);
    expect((standard.properties.metadata as any).en.description).toContain("find what is missing");
    // its aligned Lesson is a content node that carries the same lesson number
    const lesson = model.childrenOf(standard.id).find((unit) => unit.kind === "Lesson")!;
    expect(lesson).toBeTruthy();
    expect(lesson.order).toBe(15);
  });

  it("keeps chapter progression from hasDependency edges", () => {
    const chaptersWithProgression = model.unitsOfKind("Chapitre").filter((chapter) => chapter.buildsTowards.length > 0);
    expect(chaptersWithProgression.length).toBeGreaterThan(0);
  });
});

describe("generic parseGraph — reading (Scope B — daily sessions)", () => {
  const model = parseGraph(load("sources/senegal/ce1/reading/knowledge_graph.json"), READING);

  it("classifies weeks, sessions, standard leaves", () => {
    expect(model.unitsOfKind("Semaine").length).toBeGreaterThan(0);
    expect(model.unitsOfKind("Lesson").length).toBeGreaterThan(0);
    expect(leafStandards(model).length).toBeGreaterThan(0);
    expect(model.unitsOfKind("LearningComponent").length).toBeGreaterThan(0);
  });

  it("derives the week number from a bare-number description", () => {
    const week = model.unitsOfKind("Semaine").find((unit) => unit.order === 3)!;
    expect(week).toBeTruthy();
    expect(week.title).toBe("3");
  });

  it("holds Jour 1–5 day groupings, each with its sessions; all-but-Remédiation aligned to a standard", () => {
    const week = model.unitsOfKind("Semaine").find((unit) => unit.order === 3)!;
    const days = model.childrenOf(week.id).filter((unit) => unit.kind === "Jour");
    expect(days.length).toBe(5); // Jour 1–5

    const lessons = days.flatMap((day) => model.childrenOf(day.id).filter((unit) => unit.kind === "Lesson"));
    expect(lessons.length).toBe(22); // the week's full daily timetable, across the 5 days

    // session supports its standard ⇒ standard.childIds ∋ the session.
    const standardForSession = new Map<string, string>();
    for (const standard of leafStandards(model)) {
      for (const child of model.childrenOf(standard.id)) {
        if (child.kind === "Lesson") standardForSession.set(child.id, standard.id);
      }
    }
    const aligned = lessons.filter((lesson) => standardForSession.has(lesson.id));
    const unaligned = lessons.filter((lesson) => !standardForSession.has(lesson.id));
    expect(aligned.length).toBe(21); // every session but Remédiation
    expect(unaligned).toHaveLength(1);
    expect((unaligned[0].properties.metadata as { session_category?: string }).session_category).toBe("remediation");

    const withComponents = aligned.filter((lesson) => model.childrenOf(standardForSession.get(lesson.id)!).some((child) => child.kind === "LearningComponent"));
    expect(withComponents.length).toBeGreaterThan(0);
  });
});
