/*
 * Proves ONE generic parser serves both subjects: parse each real source graph
 * with its descriptor and assert the resulting CurriculumModel has the right
 * spine shape (kinds, counts, and edge-derived parent/child links). This is the
 * 2a checkpoint — the parser is validated before any adapter is wired to it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parseGraph, type GraphParseDescriptor } from "./parse-graph.js";
import type { CurriculumModel, CurriculumUnit } from "../types.js";

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
  progressionEdge: "buildsTowards",
};

// Reading is post content-layer (Scope B): the week is a content LessonGrouping
// (kept as kind `week`) holding its 22 daily sessions, each a content `Lesson`
// that `supports` the spine `expectation` it teaches (Remédiation teaches none).
const READING: GraphParseDescriptor = {
  roleToKind: { week: "week", day: "day", expectation: "expectation" },
  labelToKind: { Lesson: "lesson", LearningComponent: "component" },
  numberFrom: "position",
};

const kindCounts = (m: CurriculumModel, kinds: string[]) =>
  Object.fromEntries(kinds.map((k) => [k, m.unitsOfKind(k).length]));

describe("generic parseGraph — maths (new shape)", () => {
  const m = parseGraph(load("sources/ci/maths/knowledge_graph.json"), MATHS);

  it("classifies the maths spine by metadata.role + label", () => {
    // Canonical LC: all content groupings are `LessonGrouping` → kind "chapter".
    // The RECE task-groupings were removed (RECE is now a derived-components
    // frame with activities directly under its sub-SFIs), so all 25 groupings are
    // authored chapters.
    expect(kindCounts(m, ["week", "chapter", "domaine", "lesson", "expectation"])).toEqual({
      week: 23, chapter: 25, domaine: 4, lesson: 112, expectation: 112,
    });
    // authored chapters carry statementType "Chapitre".
    const authored = m.unitsOfKind("chapter").filter((c) => c.properties.statementType === "Chapitre");
    expect(authored.length).toBe(25);
    // components/tasks exist (incl. out-of-spine ones, matching legacy parse)
    expect(m.unitsOfKind("component").length).toBeGreaterThan(0);
    expect(m.unitsOfKind("task").length).toBeGreaterThan(0);
  });

  it("links chapter→lesson via the content edge (not a number join)", () => {
    // Only authored chapters hold lessons (task-groupings hold Activities).
    const authored = m.unitsOfKind("chapter").filter((c) => c.properties.statementType === "Chapitre");
    for (const c of authored) {
      const lessons = m.childrenOf(c.id).filter((u) => u.kind === "lesson");
      expect(lessons.length).toBeGreaterThan(0); // every authored chapter has lessons
    }
    // total chapter→lesson content links = 109 (3 palier-integration lessons hang off a domaine)
    const total = authored.reduce((n, c) => n + m.childrenOf(c.id).filter((u) => u.kind === "lesson").length, 0);
    expect(total).toBe(109);
  });

  it("links week→lesson via the schedule edge, every lesson in exactly one week", () => {
    const weeks = m.unitsOfKind("week");
    const scheduled = new Set<string>();
    for (const w of weeks) for (const l of m.childrenOf(w.id)) if (l.kind === "lesson") scheduled.add(l.id);
    expect(scheduled.size).toBe(112);
  });

  it("aligns each lesson to its expectation, which carries the OS text/category/number", () => {
    // The OS (objectif spécifique) is now the spine `expectation`; the Lesson
    // `supports` it (⇒ expectation.childIds ∋ the Lesson).
    const exp = m.unitsOfKind("expectation").find((e) => e.code === "Leçon 15")!;
    expect(exp.text).toContain("trouver ce qui manque");
    expect(exp.properties.statementType).toBe("Résolution de problème");
    expect(exp.order).toBe(15);
    expect((exp.properties.metadata as any).en.description).toContain("find what is missing");
    // its aligned Lesson is a content node that carries the same lesson number
    const lesson = m.childrenOf(exp.id).find((u) => u.kind === "lesson")!;
    expect(lesson).toBeTruthy();
    expect(lesson.order).toBe(15);
  });

  it("keeps chapter progression from buildsTowards edges", () => {
    const withProg = m.unitsOfKind("chapter").filter((c) => c.buildsTowards.length > 0);
    expect(withProg.length).toBeGreaterThan(0);
  });
});

describe("generic parseGraph — reading (Scope B — daily sessions)", () => {
  const m = parseGraph(load("sources/ce1/reading/knowledge_graph.json"), READING);

  it("classifies weeks, lessons, expectation leaves", () => {
    expect(m.unitsOfKind("week").length).toBeGreaterThan(0);
    expect(m.unitsOfKind("lesson").length).toBeGreaterThan(0);
    expect(m.unitsOfKind("expectation").length).toBeGreaterThan(0);
    expect(m.unitsOfKind("component").length).toBeGreaterThan(0);
  });

  it("derives the week number from a bare-number description", () => {
    const w = m.unitsOfKind("week").find((u) => u.order === 3)!;
    expect(w).toBeTruthy();
    expect(w.title).toBe("3");
  });

  it("holds Jour 1–5 day groupings, each with its sessions; all-but-Remédiation aligned to a standard", () => {
    const week = m.unitsOfKind("week").find((u) => u.order === 3)!;
    const days = m.childrenOf(week.id).filter((u) => u.kind === "day");
    expect(days.length).toBe(5); // Jour 1–5
    const lessons = days.flatMap((d) => m.childrenOf(d.id).filter((u) => u.kind === "lesson"));
    expect(lessons.length).toBe(22); // the week's full daily timetable, across the 5 days
    // session supports its standard ⇒ standard.childIds ∋ the session.
    const stdForSession = new Map<string, string>();
    for (const ex of m.unitsOfKind("expectation")) for (const c of m.childrenOf(ex.id)) if (c.kind === "lesson") stdForSession.set(c.id, ex.id);
    const aligned = lessons.filter((l) => stdForSession.has(l.id));
    const unaligned = lessons.filter((l) => !stdForSession.has(l.id));
    expect(aligned.length).toBe(21); // every session but Remédiation
    expect(unaligned).toHaveLength(1);
    expect((unaligned[0].properties.metadata as { session_category?: string }).session_category).toBe("remediation");
    const withComponents = aligned.filter((l) => m.childrenOf(stdForSession.get(l.id)!).some((c) => c.kind === "component"));
    expect(withComponents.length).toBeGreaterThan(0);
  });
});
