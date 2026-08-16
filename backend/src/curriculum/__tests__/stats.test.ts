/*
 * computeGraphStats — roots cap
 *
 * namespace_stats must always return small. A standards-only graph has hundreds
 * of `supports`-only leaves that are technically roots (no containment parent);
 * the stats surface the interesting roots (Course/Framework/grouping) first and
 * cap the list, reporting the true total in `rootsTotal`.
 */
import { describe, it, expect } from "vitest";
import { computeGraphStats } from "../stats.js";
import type { CurriculumModel, RawGraphSnapshot } from "../../types.js";

const modelOf = (raw: RawGraphSnapshot): CurriculumModel => ({ rawGraph: raw }) as unknown as CurriculumModel;

describe("computeGraphStats roots cap", () => {
  it("caps roots at 50 but reports the true total, and keeps flags accurate", () => {
    // 1 framework + 300 supports-only LearningComponents = 301 roots (none have an
    // inbound hasChild/hasPart), mirroring the Nigeria standards-only shape.
    const raw: RawGraphSnapshot = {
      nodes: [
        { id: "fw", labels: ["StandardsFramework"], properties: {} },
        ...Array.from({ length: 300 }, (_u, i) => ({ id: `lc${i}`, labels: ["LearningComponent"], properties: {} })),
      ],
      relationships: Array.from({ length: 300 }, (_u, i) => ({
        id: `supports:lc${i}->fw`, type: "supports", start: `lc${i}`, end: "fw", properties: {},
      })),
    } as unknown as RawGraphSnapshot;

    const stats = computeGraphStats(modelOf(raw));
    expect(stats.rootsTotal).toBe(301);       // every node is a root here
    expect(stats.roots.length).toBe(50);      // capped
    // The framework (interesting) sorts ahead of the LearningComponent leaves.
    expect(stats.roots[0].labels).toContain("StandardsFramework");
    // Flags come from the FULL set, so "no Course" is still reported after the cap.
    expect(stats.structuralFlags).toContain("no Course (content root) authored");
  });

  it("does not cap or note when roots fit under the limit", () => {
    const raw: RawGraphSnapshot = {
      nodes: [
        { id: "course", labels: ["Course"], properties: {} },
        { id: "ch1", labels: ["LessonGrouping"], properties: {} },
      ],
      relationships: [{ id: "hasPart:course->ch1", type: "hasPart", start: "course", end: "ch1", properties: {} }],
    } as unknown as RawGraphSnapshot;

    const stats = computeGraphStats(modelOf(raw));
    expect(stats.rootsTotal).toBe(1);         // only the Course is a root
    expect(stats.roots.length).toBe(1);
    expect(stats.roots[0].labels).toContain("Course");
  });
});
