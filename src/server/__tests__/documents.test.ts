/*
 * list_documents pagination — pageDocuments() paging contract
 *
 * pageDocuments is the pure paging over the already-(unit asc, nodeId asc)-sorted
 * history. These tests pin the limit + opaque-cursor contract without standing up
 * storage: default/clamped limits, walking pages via nextCursor with no overlap or
 * gaps, a null nextCursor on the final page, a rejected bad cursor, and the
 * nodeId/unit filters. A document is keyed by the scope node it covers (nodeId).
 */
import { describe, it, expect } from "vitest";
import { pageDocuments } from "../documents.js";
import type { HistoryEntry } from "../../types.js";

// Minimal entries in listEntries() order: (unit asc, then nodeId asc). Two
// documents per chapter (its manual + its lesson sheets, distinct scope nodes)
// exercise the tie-break on nodeId — "ch1-lessons" sorts before "ch1-manual".
function entry(unit: number, kind: "lessons" | "manual"): HistoryEntry {
  const nodeId = `ch${unit}-${kind}`;
  return {
    id: nodeId, nodeId, unit,
    relPath: `chapitre_${unit}/${kind}.docx`,
    md5: "x", updated: "", source: "pipeline", recordedAt: "", content: {},
  };
}

// 10 chapters × { lessons, manual } = 20 entries, already sorted the way
// listEntries() returns them (within a unit, nodeId "…-lessons" < "…-manual").
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
    expect(page.entries[0].nodeId).toBe("ch1-lessons");
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
      seen.push(...page.entries.map((e) => e.nodeId));
      cursor = page.nextCursor;
      if (++guard > 100) {
        throw new Error("pagination did not terminate");
      }
    } while (cursor != null);

    // Exactly the full set, in order, each nodeId once.
    expect(seen).toEqual(ALL.map((e) => e.nodeId));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("returns a non-null cursor only while more remains", () => {
    const firstPage = ok(pageDocuments(ALL, { limit: 18 }));
    expect(firstPage.count).toBe(18);
    expect(firstPage.nextCursor).not.toBeNull();

    const last = ok(pageDocuments(ALL, { cursor: firstPage.nextCursor!, limit: 18 }));
    expect(last.count).toBe(2);
    expect(last.nextCursor).toBeNull();      // remainder < limit → final page
    expect(last.entries.map((e) => e.nodeId)).toEqual(["ch10-lessons", "ch10-manual"]);
  });

  it("orders by the numeric unit, not the lexical nodeId (10 after 2)", () => {
    // The cursor carries {unit,nodeId}, so paging past unit 2 must still surface
    // unit 10 later, never before it — even though "ch10-…" sorts lexically
    // before "ch2-…".
    const idx10 = ALL.findIndex((e) => e.nodeId === "ch10-lessons");
    const idx2 = ALL.findIndex((e) => e.nodeId === "ch2-lessons");
    expect(idx2).toBeLessThan(idx10);
  });

  it("preserves the (already-sorted) order, unit-less entries kept at the tail", () => {
    // pageDocuments pages the ALREADY-sorted history (listEntries does the sort,
    // placing a unit-less entry last). Passing pre-sorted input, the unit-less
    // tail must survive a full page.
    const orphan: HistoryEntry = { ...entry(1, "manual"), id: "loose", nodeId: "loose", unit: undefined };
    const page = ok(pageDocuments([...ALL, orphan], { limit: 100 }));
    expect(page.entries[page.entries.length - 1].nodeId).toBe("loose");
  });

  it("rejects a malformed cursor rather than silently restarting", () => {
    const result = pageDocuments(ALL, { cursor: "not-a-real-cursor" });
    expect("error" in result && result.error).toContain("Invalid cursor");
  });

  it("treats an absent cursor as the first page", () => {
    const page = ok(pageDocuments(ALL, { limit: 3 }));
    expect(page.entries[0].nodeId).toBe("ch1-lessons");
    expect(page.count).toBe(3);
  });

  it("filters by unit, narrowing total but keeping totalUnfiltered", () => {
    const page = ok(pageDocuments(ALL, { unit: 3 }));
    expect(page.entries.map((e) => e.nodeId)).toEqual(["ch3-lessons", "ch3-manual"]);
    expect(page.total).toBe(2);              // the filtered set
    expect(page.totalUnfiltered).toBe(20);   // the whole history
    expect(page.nextCursor).toBeNull();
  });

  it("filters by nodeId to a single scope node's document", () => {
    const page = ok(pageDocuments(ALL, { nodeId: "ch7-manual" }));
    expect(page.entries.map((e) => e.nodeId)).toEqual(["ch7-manual"]);
    expect(page.total).toBe(1);
    expect(page.totalUnfiltered).toBe(20);
  });

  it("paginates WITHIN a unit filter without leaking other chapters", () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let guard = 0;
    do {
      const page = ok(pageDocuments(ALL, { unit: 5, cursor: cursor ?? undefined, limit: 1 }));
      seen.push(...page.entries.map((e) => e.nodeId));
      cursor = page.nextCursor;
      if (++guard > 50) {
        throw new Error("did not terminate");
      }
    } while (cursor != null);
    expect(seen).toEqual(["ch5-lessons", "ch5-manual"]);
  });

  it("returns an empty page (not an error) when a filter matches nothing", () => {
    const page = ok(pageDocuments(ALL, { unit: 999 }));
    expect(page.count).toBe(0);
    expect(page.total).toBe(0);
    expect(page.nextCursor).toBeNull();
  });
});
