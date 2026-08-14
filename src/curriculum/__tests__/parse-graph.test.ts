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

// Descriptors mirror what the adapters declare. Maths is the post-split
// (graph-native-authoring) shape: chapters are content LessonGroupings, lessons
// are content Lesson nodes that `supports` a spine `expectation` (the OS).
const MATHS: GraphParseDescriptor = {
  roleToKind: {
    week: "week",
    strand: "domaine",
    expectation: "expectation",
    "intégration du palier": "expectation",
  },
  labelToKind: { Lesson: "lesson", LessonGrouping: "chapter", LearningComponent: "component", Activity: "task" },
  numberFrom: "order",
  dependencyEdge: "hasDependency",
};

// Reading is post content-layer (Scope B): the week is a content LessonGrouping
// (kept as kind `week`) holding its 22 daily sessions, each a content `Lesson`
// that `supports` the spine `expectation` it teaches (Remédiation teaches none).
const READING: GraphParseDescriptor = {
  roleToKind: { week: "week", day: "day", expectation: "expectation" },
  labelToKind: { Lesson: "lesson", LearningComponent: "component" },
  numberFrom: "position",
};

const kindCounts = (model: CurriculumModel, kinds: string[]) =>
  Object.fromEntries(kinds.map((kind) => [kind, model.unitsOfKind(kind).length]));

describe("generic parseGraph — maths (new shape)", () => {
  const model = parseGraph(load("sources/senegal/ci/maths/knowledge_graph.json"), MATHS);

  it("classifies the maths spine by metadata.role + label", () => {
    // Canonical LC: all content groupings are `LessonGrouping` → kind "chapter".
    // The RECE task-groupings were removed (RECE is now a derived-components
    // frame with activities directly under its sub-SFIs), so all 25 groupings are
    // authored chapters.
    // lesson = 112 weekly (Teacher's Guide) + 25 Student's-Book container lessons.
    expect(kindCounts(model, ["week", "chapter", "domaine", "lesson", "expectation"])).toEqual({
      week: 23, chapter: 25, domaine: 4, lesson: 137, expectation: 112,
    });
    // authored chapters carry groupName "Chapitre".
    const authored = model.unitsOfKind("chapter").filter((chapter) => chapter.properties.groupName === "Chapitre");
    expect(authored.length).toBe(25);
    // components/tasks exist (incl. out-of-spine ones, matching legacy parse)
    expect(model.unitsOfKind("component").length).toBeGreaterThan(0);
    expect(model.unitsOfKind("task").length).toBeGreaterThan(0);
  });

  it("links chapter→lesson→activity via the content tree (not a number join)", () => {
    // Canonical content nesting: chapter (LessonGrouping) ▸ Lesson ▸ Activity.
    // The weekly teaching lessons live in the Teacher's Guide (week→lesson); each
    // chapter holds ONE Student's-Book container Lesson, which holds that
    // chapter's Activities (218 total, 2 per former lesson).
    const authored = model.unitsOfKind("chapter").filter((chapter) => chapter.properties.groupName === "Chapitre");
    let chapterLessons = 0;
    let activities = 0;
    for (const chapter of authored) {
      const lessons = model.childrenOf(chapter.id).filter((unit) => unit.kind === "lesson");
      expect(lessons.length).toBe(1);
      chapterLessons += lessons.length;
      for (const lesson of lessons) {
        const tasks = model.childrenOf(lesson.id).filter((unit) => unit.kind === "task");
        expect(tasks.length).toBeGreaterThan(0);
        activities += tasks.length;
      }
    }
    expect(chapterLessons).toBe(25);
    expect(activities).toBe(218);
  });

  it("links week→lesson via the schedule edge, every lesson in exactly one week", () => {
    const weeks = model.unitsOfKind("week");
    const scheduled = new Set<string>();
    for (const week of weeks) {
      for (const lesson of model.childrenOf(week.id)) {
        if (lesson.kind === "lesson") scheduled.add(lesson.id);
      }
    }
    expect(scheduled.size).toBe(112);
  });

  it("aligns each lesson to its expectation, which carries the OS text/category/number", () => {
    // The OS (objectif spécifique) is now the spine `expectation`; the Lesson
    // `supports` it (⇒ expectation.childIds ∋ the Lesson).
    const expectation = model.unitsOfKind("expectation").find((unit) => unit.code === "Leçon 15")!;
    expect(expectation.text).toContain("trouver ce qui manque");
    expect(expectation.properties.statementType).toBe("Résolution de problème");
    expect(expectation.order).toBe(15);
    expect((expectation.properties.metadata as any).en.description).toContain("find what is missing");
    // its aligned Lesson is a content node that carries the same lesson number
    const lesson = model.childrenOf(expectation.id).find((unit) => unit.kind === "lesson")!;
    expect(lesson).toBeTruthy();
    expect(lesson.order).toBe(15);
  });

  it("keeps chapter progression from hasDependency edges", () => {
    const chaptersWithProgression = model.unitsOfKind("chapter").filter((chapter) => chapter.buildsTowards.length > 0);
    expect(chaptersWithProgression.length).toBeGreaterThan(0);
  });
});

describe("generic parseGraph — reading (Scope B — daily sessions)", () => {
  const model = parseGraph(load("sources/senegal/ce1/reading/knowledge_graph.json"), READING);

  it("classifies weeks, lessons, expectation leaves", () => {
    expect(model.unitsOfKind("week").length).toBeGreaterThan(0);
    expect(model.unitsOfKind("lesson").length).toBeGreaterThan(0);
    expect(model.unitsOfKind("expectation").length).toBeGreaterThan(0);
    expect(model.unitsOfKind("component").length).toBeGreaterThan(0);
  });

  it("derives the week number from a bare-number description", () => {
    const week = model.unitsOfKind("week").find((unit) => unit.order === 3)!;
    expect(week).toBeTruthy();
    expect(week.title).toBe("3");
  });

  it("holds Jour 1–5 day groupings, each with its sessions; all-but-Remédiation aligned to a standard", () => {
    const week = model.unitsOfKind("week").find((unit) => unit.order === 3)!;
    const days = model.childrenOf(week.id).filter((unit) => unit.kind === "day");
    expect(days.length).toBe(5); // Jour 1–5

    const lessons = days.flatMap((day) => model.childrenOf(day.id).filter((unit) => unit.kind === "lesson"));
    expect(lessons.length).toBe(22); // the week's full daily timetable, across the 5 days

    // session supports its standard ⇒ standard.childIds ∋ the session.
    const standardForSession = new Map<string, string>();
    for (const expectation of model.unitsOfKind("expectation")) {
      for (const child of model.childrenOf(expectation.id)) {
        if (child.kind === "lesson") standardForSession.set(child.id, expectation.id);
      }
    }
    const aligned = lessons.filter((lesson) => standardForSession.has(lesson.id));
    const unaligned = lessons.filter((lesson) => !standardForSession.has(lesson.id));
    expect(aligned.length).toBe(21); // every session but Remédiation
    expect(unaligned).toHaveLength(1);
    expect((unaligned[0].properties.metadata as { session_category?: string }).session_category).toBe("remediation");

    const withComponents = aligned.filter((lesson) => model.childrenOf(standardForSession.get(lesson.id)!).some((child) => child.kind === "component"));
    expect(withComponents.length).toBeGreaterThan(0);
  });
});
