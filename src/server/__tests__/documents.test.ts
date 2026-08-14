/*
 * list_documents pagination — pageDocuments() paging contract
 *
 * pageDocuments is the pure paging over the already-(unit asc, type asc)-sorted
 * history. These tests pin the limit + opaque-cursor contract without standing up
 * storage: default/clamped limits, walking pages via nextCursor with no overlap or
 * gaps, a null nextCursor on the final page, and a rejected bad cursor.
 */
import { describe, it, expect } from "vitest";
import { pageDocuments } from "../documents.js";
import type { HistoryEntry } from "../../types.js";

// Minimal entries in listEntries() order: (unit asc, then type asc). Two
// deliverables per unit exercise the tie-break on `type`.
function entry(unit: number, type: string): HistoryEntry {
  return {
    id: `${unit}:${type}`,
    unit,
    type: type as HistoryEntry["type"],
    relPath: `chapitre_${unit}/${type}.docx`,
    md5: "x", updated: "", source: "pipeline", recordedAt: "", content: {},
  };
}

// 10 chapters × { lessons, manual } = 20 entries, already sorted the way
// listEntries() returns them (type sorts "lessons" < "manual").
const ALL: HistoryEntry[] = Array.from({ length: 10 }, (_, i) => i + 1).flatMap(
  (c) => [entry(c, "lessons"), entry(c, "manual")]
);

// Type guard so the tests read cleanly past the {error} union arm.
function ok(result: ReturnType<typeof pageDocuments>) {
  if ("error" in result) {
    throw new Error(`expected a page, got error: ${result.error}`);
  }
  return result;
}

describe("pageDocuments", () => {
  it("defaults to a 25-item page and reports the true total", () => {
    const page = ok(pageDocuments(ALL, {}));
    expect(page.total).toBe(20);
    expect(page.count).toBe(20);         // fewer than the 25 default → single page
    expect(page.nextCursor).toBeNull();
    expect(page.entries[0].id).toBe("1:lessons");
  });

  it("clamps limit into [1,100]", () => {
    expect(ok(pageDocuments(ALL, { limit: 0 })).count).toBe(1);      // floored up to 1
    expect(ok(pageDocuments(ALL, { limit: -5 })).count).toBe(1);
    expect(ok(pageDocuments(ALL, { limit: 999 })).count).toBe(20);   // capped, but only 20 exist
    expect(ok(pageDocuments(ALL, { limit: 7 })).count).toBe(7);
  });

  it("walks every entry across pages with no overlap and no gaps", () => {
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    let guard = 0;
    do {
      const page = ok(pageDocuments(ALL, { cursor: cursor ?? undefined, limit: 6 }));
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      if (++guard > 100) {
        throw new Error("pagination did not terminate");
      }
    } while (cursor != null);

    // Exactly the full set, in order, each id once.
    expect(seen).toEqual(ALL.map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("returns a non-null cursor only while more remains", () => {
    const firstPage = ok(pageDocuments(ALL, { limit: 18 }));
    expect(firstPage.count).toBe(18);
    expect(firstPage.nextCursor).not.toBeNull();

    const last = ok(pageDocuments(ALL, { cursor: firstPage.nextCursor!, limit: 18 }));
    expect(last.count).toBe(2);
    expect(last.nextCursor).toBeNull();      // remainder < limit → final page
    expect(last.entries.map((e) => e.id)).toEqual(["10:lessons", "10:manual"]);
  });

  it("orders the tie-break on type after the numeric unit (10 after 2)", () => {
    // The cursor carries {unit,type}, not the lexical id — so paging past
    // unit 2 must still surface unit 10 later, never before it.
    const idx10 = ALL.findIndex((e) => e.id === "10:lessons");
    const idx2 = ALL.findIndex((e) => e.id === "2:lessons");
    expect(idx2).toBeLessThan(idx10);
  });

  it("rejects a malformed cursor rather than silently restarting", () => {
    const result = pageDocuments(ALL, { cursor: "not-a-real-cursor" });
    expect("error" in result && result.error).toContain("Invalid cursor");
  });

  it("treats an absent cursor as the first page", () => {
    const page = ok(pageDocuments(ALL, { limit: 3 }));
    expect(page.entries[0].id).toBe("1:lessons");
    expect(page.count).toBe(3);
  });

  it("filters by unit, narrowing total but keeping totalUnfiltered", () => {
    const page = ok(pageDocuments(ALL, { unit: 3 }));
    expect(page.entries.map((e) => e.id)).toEqual(["3:lessons", "3:manual"]);
    expect(page.total).toBe(2);              // the filtered set
    expect(page.totalUnfiltered).toBe(20);   // the whole history
    expect(page.nextCursor).toBeNull();
  });

  it("filters by type across all chapters", () => {
    const page = ok(pageDocuments(ALL, { type: "manual", limit: 100 }));
    expect(page.count).toBe(10);
    expect(page.entries.every((e) => e.type === "manual")).toBe(true);
    expect(page.total).toBe(10);
  });

  it("combines unit + type to a single entry", () => {
    const page = ok(pageDocuments(ALL, { unit: 7, type: "lessons" }));
    expect(page.entries.map((e) => e.id)).toEqual(["7:lessons"]);
    expect(page.total).toBe(1);
  });

  it("paginates WITHIN a filtered set without leaking other chapters", () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let guard = 0;
    do {
      const page = ok(pageDocuments(ALL, { type: "manual", cursor: cursor ?? undefined, limit: 4 }));
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      if (++guard > 50) {
        throw new Error("did not terminate");
      }
    } while (cursor != null);
    expect(seen).toEqual(ALL.filter((e) => e.type === "manual").map((e) => e.id));
    expect(seen.every((id) => id.endsWith(":manual"))).toBe(true);
  });

  it("returns an empty page (not an error) when a filter matches nothing", () => {
    const page = ok(pageDocuments(ALL, { unit: 999 }));
    expect(page.count).toBe(0);
    expect(page.total).toBe(0);
    expect(page.nextCursor).toBeNull();
  });
});
