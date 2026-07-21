import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HistoryEntry } from "../types.js";

function makeEntry(chapter: number, domains: string[]): HistoryEntry {
  return {
    id: `${chapter}:manual`, chapter, type: "manual", relPath: `ch${chapter}.docx`,
    md5: "abc", updated: "2025-01-01", source: "pipeline", recordedAt: "2025-01-01",
    content: { exampleDomains: domains },
  };
}

vi.mock("../storage/index.js", () => ({
  listEntries: vi.fn(),
}));

vi.mock("../config.js", () => ({
  CONFIG: { exampleDomainsFile: "example_domains.json" },
}));

vi.mock("../context-state.js", () => ({
  sourcePath: () => "/nonexistent/example_domains.json",
}));

import { listEntries } from "../storage/index.js";
import { neighborhoodDomains, suggestFreshDomain, domainUsage } from "./domains.js";

const mockListEntries = vi.mocked(listEntries);

describe("neighborhoodDomains", () => {
  const entries: HistoryEntry[] = [
    makeEntry(10, ["fruits"]),
    makeEntry(11, ["legumes"]),
    makeEntry(12, ["animals"]),
    makeEntry(13, ["tam-tams"]),
    makeEntry(15, ["pirogues"]),
    makeEntry(18, ["cordes"]),
    makeEntry(20, ["paniers"]),
  ];

  beforeEach(() => { mockListEntries.mockResolvedValue(entries); });

  it("returns only chapters within ±K of target, excluding target itself", async () => {
    const result = await neighborhoodDomains(12, 2);
    expect(Object.keys(result).map(Number).sort((a, b) => a - b)).toEqual([10, 11, 13]);
    expect(result[10]).toEqual(["fruits"]);
    expect(result[11]).toEqual(["legumes"]);
    expect(result[13]).toEqual(["tam-tams"]);
    expect(result[15]).toBeUndefined();
  });

  it("uses chapter NUMBER distance, not array position", async () => {
    const result = await neighborhoodDomains(15, 2);
    expect(Object.keys(result).map(Number).sort((a, b) => a - b)).toEqual([13]);
    expect(result[12]).toBeUndefined();
    expect(result[18]).toBeUndefined();
  });

  it("skips chapters with no domains", async () => {
    mockListEntries.mockResolvedValue([
      ...entries,
      { ...makeEntry(14, []), content: { exampleDomains: [] } } as HistoryEntry,
    ]);
    const result = await neighborhoodDomains(13, 2);
    expect(result[14]).toBeUndefined();
    expect(result[12]).toEqual(["animals"]);
  });

  it("returns empty object when no neighbors exist within K", async () => {
    const result = await neighborhoodDomains(18, 1);
    expect(result).toEqual({});
  });

  it("handles K=1 correctly", async () => {
    const result = await neighborhoodDomains(12, 1);
    expect(Object.keys(result).map(Number).sort((a, b) => a - b)).toEqual([11, 13]);
  });

  it("merges domains from multiple entries for the same chapter", async () => {
    mockListEntries.mockResolvedValue([
      ...entries,
      makeEntry(11, ["ballons"]),
    ]);
    const result = await neighborhoodDomains(12, 1);
    expect(result[11]).toEqual(expect.arrayContaining(["legumes", "ballons"]));
    expect(result[11]).toHaveLength(2);
  });
});

describe("suggestFreshDomain with avoidNearby", () => {
  beforeEach(() => { mockListEntries.mockResolvedValue([]); });

  it("avoids domains that appear in avoidNearby", async () => {
    const nearby = { 9: ["fruits"], 11: ["legumes"] };
    const result = await suggestFreshDomain(nearby);
    expect(result).toBe("animals");
  });

  it("returns null when all candidates are in avoidNearby", async () => {
    const allDomains = ["fruits", "legumes", "animals", "tam-tams", "pirogues", "cordes", "paniers", "calebasses", "ballons", "ardoises"];
    const nearby = { 1: allDomains };
    const result = await suggestFreshDomain(nearby);
    expect(result).toBeNull();
  });

  it("falls back to LRU from non-nearby used domains", async () => {
    mockListEntries.mockResolvedValue([
      makeEntry(1, ["fruits", "legumes", "animals", "tam-tams", "pirogues", "cordes", "paniers", "calebasses", "ballons", "ardoises"]),
    ]);
    const nearby = { 9: ["fruits"], 11: ["legumes"] };
    const result = await suggestFreshDomain(nearby);
    expect(result).not.toBe("fruits");
    expect(result).not.toBe("legumes");
    expect(result).toBe("animals");
  });

  it("works without avoidNearby (standalone tool behavior)", async () => {
    const result = await suggestFreshDomain();
    expect(result).toBe("fruits");
  });
});

describe("payload boundedness", () => {
  it("avoidNearby size is bounded by K, not total chapter count", async () => {
    const manyEntries = Array.from({ length: 50 }, (_, i) =>
      makeEntry(i + 1, [`domain-${i + 1}`])
    );
    mockListEntries.mockResolvedValue(manyEntries);

    const k = 3;
    const result = await neighborhoodDomains(25, k);
    const chapterNums = Object.keys(result).map(Number);
    for (const ch of chapterNums) {
      expect(Math.abs(ch - 25)).toBeLessThanOrEqual(k);
    }
    expect(chapterNums.length).toBeLessThanOrEqual(2 * k);
  });
});
