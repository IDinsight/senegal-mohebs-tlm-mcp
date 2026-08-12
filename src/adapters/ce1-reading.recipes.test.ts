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

  it("opts into only the recipes that fit (not week split/renumber)", () => {
    expect(a.availableRecipes).toEqual(["move_lesson"]);
    // The capabilities mirror renders exactly the allowlist.
    const shown = RECIPES.filter((r) => !a.availableRecipes || a.availableRecipes.includes(r.name)).map((r) => r.name);
    expect(shown).toEqual(["move_lesson"]);
    expect(shown).not.toContain("renumber");
    expect(shown).not.toContain("split_lesson_grouping");
  });

  it("maths keeps the full family (no allowlist)", () => {
    const m = resolveAdapter("ci", "maths")!;
    expect(m.availableRecipes).toBeUndefined();
  });
});
