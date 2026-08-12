// ── CE1 reading — scoped recipe surface (Scope C groundwork) ─────────────────
// Reading opts into ONLY the recipes that fit its structure (per-recipe
// availability), not the whole family — weeks are the fixed 1–25 timetable, so
// week-level split/renumber don't apply. It uses canonical LC content edges.
import { describe, it, expect } from "vitest";
import { resolveAdapter } from "./index.js";
import { RECIPES } from "../kg-store/index.js";

describe("CE1 reading — scoped recipe surface", () => {
  const a = resolveAdapter("ce1", "reading")!;

  it("declares a recipeProfile with canonical content edges + activity/material kinds", () => {
    expect(a.recipeProfile?.containerEdge).toBe("hasPart");
    expect(a.recipeProfile?.alignmentEdge).toBe("hasEducationalAlignment");
    expect(a.recipeProfile?.chapterKind).toBe("week");
    expect(a.recipeProfile?.lessonKind).toBe("lesson");
    expect(a.recipeProfile?.activityKind).toBe("activity");
    expect(a.recipeProfile?.materialKind).toBe("material");
    expect(a.structuralAliases).toBeTruthy();
  });

  it("opts into session reordering + the content recipes (not week split/renumber)", () => {
    expect(a.availableRecipes).toEqual(["move_lesson", "add_activity", "add_material", "set_material_content"]);
    // The capabilities mirror renders exactly the allowlist — the content
    // recipes are shown; the week-level structural ones are not.
    const shown = RECIPES.filter((r) => !a.availableRecipes || a.availableRecipes.includes(r.name)).map((r) => r.name);
    expect(shown).toEqual(["move_lesson", "add_activity", "add_material", "set_material_content"]);
    expect(shown).not.toContain("renumber");
    expect(shown).not.toContain("split_lesson_grouping");
    expect(shown).not.toContain("add_lesson_grouping");
  });

  it("the content recipes exist in the registry with the shape reading uses", () => {
    const byName = new Map(RECIPES.map((r) => [r.name, r]));
    // add_activity: lesson-scoped, no expectation param (alignment inherited).
    const act = byName.get("add_activity")!;
    expect(act.params.map((p) => p.name)).toContain("lessonId");
    expect(act.params.map((p) => p.name)).not.toContain("expectationId");
    // add_material: parent can be any container; content is required.
    const mat = byName.get("add_material")!;
    expect(mat.params.find((p) => p.name === "content")?.required).toBe(true);
    expect(mat.params.find((p) => p.name === "parentId")?.note).toMatch(/Activity, Lesson, or LessonGrouping/i);
    // set_material_content: exists, content required.
    const setc = byName.get("set_material_content")!;
    expect(setc.params.find((p) => p.name === "content")?.required).toBe(true);
  });

  it("maths keeps the full family (no allowlist)", () => {
    const m = resolveAdapter("ci", "maths")!;
    expect(m.availableRecipes).toBeUndefined();
  });
});
