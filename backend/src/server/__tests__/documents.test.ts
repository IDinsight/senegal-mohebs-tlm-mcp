/*
 * list_documents pagination — pageDocuments() paging contract
 *
 * pageDocuments orders the history by (graph ordinal asc, nodeId asc) — the
 * ordinal is resolved per entry from the active graph via an injected `ordinalOf`
 * (here a fake that reads the chapter number out of the nodeId), not a stored
 * field. These tests pin the limit + opaque-cursor contract without standing up
 * storage: default/clamped limits, walking pages via nextCursor with no overlap
 * or gaps, a null nextCursor on the final page, a rejected bad cursor, and the
 * nodeId/unit filters. A document is keyed by the scope node it covers (nodeId).
 */
import { describe, it, expect } from "vitest";
import { pageDocuments, pageDocumentText, DOC_TEXT_DEFAULT_MAX_CHARS, DOC_TEXT_MAX_CHARS } from "../documents.js";
import type { HistoryEntry } from "../../types.js";

// Two documents per chapter (its manual + its lesson sheets, distinct scope
// nodes) exercise the tie-break on nodeId — "ch1-lessons" sorts before
// "ch1-manual". The chapter number lives only in the nodeId now.
function entry(unit: number, kind: "lessons" | "manual"): HistoryEntry {
  const nodeId = `ch${unit}-${kind}`;
  return {
    id: nodeId, nodeId,
    relPath: `chapitre_${unit}/${kind}.docx`,
    md5: "x", updated: "", source: "pipeline", recordedAt: "", content: {},
  };
}

// The fake ordinal resolver: read the chapter number from the nodeId (a real
// deployment reads node.order from the active model). A node it can't place
// (e.g. "loose") resolves to null and sorts to the tail.
const ordinalOf = (nodeId: string): number | null => {
  const m = /^ch(\d+)-/.exec(nodeId);
  return m ? Number(m[1]) : null;
};

// 10 chapters × { lessons, manual } = 20 entries. Deliberately NOT pre-sorted by
// ordinal — pageDocuments does the (ordinal, nodeId) sort itself now.
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
    const page = ok(pageDocuments(ALL, ordinalOf, {}));
    expect(page.total).toBe(20);
    expect(page.count).toBe(20);         // fewer than the 25 default → single page
    expect(page.nextCursor).toBeNull();
    expect(page.entries[0].nodeId).toBe("ch1-lessons");
  });

  it("clamps limit into [1,100]", () => {
    expect(ok(pageDocuments(ALL, ordinalOf, { limit: 0 })).count).toBe(1);      // floored up to 1
    expect(ok(pageDocuments(ALL, ordinalOf, { limit: -5 })).count).toBe(1);
    expect(ok(pageDocuments(ALL, ordinalOf, { limit: 999 })).count).toBe(20);   // capped, but only 20 exist
    expect(ok(pageDocuments(ALL, ordinalOf, { limit: 7 })).count).toBe(7);
  });

  it("walks every entry across pages with no overlap and no gaps", () => {
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    let guard = 0;
    do {
      const page = ok(pageDocuments(ALL, ordinalOf, { cursor: cursor ?? undefined, limit: 6 }));
      seen.push(...page.entries.map((e) => e.nodeId));
      cursor = page.nextCursor;
      if (++guard > 100) {
        throw new Error("pagination did not terminate");
      }
    } while (cursor != null);

    // Exactly the full set, in (ordinal, nodeId) order, each nodeId once.
    const expected = [...ALL].sort(
      (a, b) => (ordinalOf(a.nodeId)! - ordinalOf(b.nodeId)!) || a.nodeId.localeCompare(b.nodeId),
    ).map((e) => e.nodeId);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("returns a non-null cursor only while more remains", () => {
    const firstPage = ok(pageDocuments(ALL, ordinalOf, { limit: 18 }));
    expect(firstPage.count).toBe(18);
    expect(firstPage.nextCursor).not.toBeNull();

    const last = ok(pageDocuments(ALL, ordinalOf, { cursor: firstPage.nextCursor!, limit: 18 }));
    expect(last.count).toBe(2);
    expect(last.nextCursor).toBeNull();      // remainder < limit → final page
    expect(last.entries.map((e) => e.nodeId)).toEqual(["ch10-lessons", "ch10-manual"]);
  });

  it("orders by the numeric ordinal, not the lexical nodeId (10 after 2)", () => {
    // The cursor carries {unit,nodeId}, so paging past chapter 2 must still
    // surface chapter 10 later, never before it — even though "ch10-…" sorts
    // lexically before "ch2-…".
    const walked: string[] = [];
    let cursor: string | null | undefined;
    let guard = 0;
    do {
      const page = ok(pageDocuments(ALL, ordinalOf, { cursor: cursor ?? undefined, limit: 3 }));
      walked.push(...page.entries.map((e) => e.nodeId));
      cursor = page.nextCursor;
      if (++guard > 100) throw new Error("did not terminate");
    } while (cursor != null);
    expect(walked.indexOf("ch2-lessons")).toBeLessThan(walked.indexOf("ch10-lessons"));
  });

  it("sorts a node with no ordinal to the tail", () => {
    // A history entry whose scope node is gone from the graph resolves to a null
    // ordinal; it must sort after every placed chapter.
    const orphan: HistoryEntry = { ...entry(1, "manual"), id: "loose", nodeId: "loose" };
    const page = ok(pageDocuments([...ALL, orphan], ordinalOf, { limit: 100 }));
    expect(page.entries[page.entries.length - 1].nodeId).toBe("loose");
  });

  it("rejects a malformed cursor rather than silently restarting", () => {
    const result = pageDocuments(ALL, ordinalOf, { cursor: "not-a-real-cursor" });
    expect("error" in result && result.error).toContain("Invalid cursor");
  });

  it("treats an absent cursor as the first page", () => {
    const page = ok(pageDocuments(ALL, ordinalOf, { limit: 3 }));
    expect(page.entries[0].nodeId).toBe("ch1-lessons");
    expect(page.count).toBe(3);
  });

  it("filters by unit, narrowing total but keeping totalUnfiltered", () => {
    const page = ok(pageDocuments(ALL, ordinalOf, { unit: 3 }));
    expect(page.entries.map((e) => e.nodeId)).toEqual(["ch3-lessons", "ch3-manual"]);
    expect(page.total).toBe(2);              // the filtered set
    expect(page.totalUnfiltered).toBe(20);   // the whole history
    expect(page.nextCursor).toBeNull();
  });

  it("filters by nodeId to a single scope node's document", () => {
    const page = ok(pageDocuments(ALL, ordinalOf, { nodeId: "ch7-manual" }));
    expect(page.entries.map((e) => e.nodeId)).toEqual(["ch7-manual"]);
    expect(page.total).toBe(1);
    expect(page.totalUnfiltered).toBe(20);
  });

  it("paginates WITHIN a unit filter without leaking other chapters", () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let guard = 0;
    do {
      const page = ok(pageDocuments(ALL, ordinalOf, { unit: 5, cursor: cursor ?? undefined, limit: 1 }));
      seen.push(...page.entries.map((e) => e.nodeId));
      cursor = page.nextCursor;
      if (++guard > 50) {
        throw new Error("did not terminate");
      }
    } while (cursor != null);
    expect(seen).toEqual(["ch5-lessons", "ch5-manual"]);
  });

  it("returns an empty page (not an error) when a filter matches nothing", () => {
    const page = ok(pageDocuments(ALL, ordinalOf, { unit: 999 }));
    expect(page.count).toBe(0);
    expect(page.total).toBe(0);
    expect(page.nextCursor).toBeNull();
  });
});

describe("pageDocumentText", () => {
  const REL = "chapitre_05/manuel.docx";

  it("returns the whole document in one page when it fits, with nextOffset null", () => {
    const full = "abc";
    const page = pageDocumentText(REL, full);
    expect(page).toMatchObject({ relPath: REL, offset: 0, returned: 3, total: 3, nextOffset: null, text: "abc" });
  });

  it("caps a page at maxChars and points nextOffset at the remainder", () => {
    const full = "x".repeat(120);
    const page = pageDocumentText(REL, full, 0, 50);
    expect(page.returned).toBe(50);
    expect(page.total).toBe(120);
    expect(page.nextOffset).toBe(50);
    expect(page.text).toBe("x".repeat(50));
  });

  it("reads the WHOLE document across pages via nextOffset with no overlap or gaps", () => {
    const full = Array.from({ length: 250 }, (_unused, index) => String.fromCharCode(97 + (index % 26))).join("");
    let offset: number | null = 0;
    let collected = "";
    let guard = 0;
    while (offset !== null) {
      const page: ReturnType<typeof pageDocumentText> = pageDocumentText(REL, full, offset, 60);
      collected += page.text;
      expect(page.offset).toBe(offset);          // each page starts exactly where the last said to resume
      offset = page.nextOffset;
      if (++guard > 100) throw new Error("pagination did not terminate");
    }
    expect(collected).toBe(full);                // reassembling the windows yields the original, byte-for-byte
  });

  it("defaults the window to DOC_TEXT_DEFAULT_MAX_CHARS", () => {
    const full = "y".repeat(DOC_TEXT_DEFAULT_MAX_CHARS + 500);
    const page = pageDocumentText(REL, full);
    expect(page.returned).toBe(DOC_TEXT_DEFAULT_MAX_CHARS);
    expect(page.nextOffset).toBe(DOC_TEXT_DEFAULT_MAX_CHARS);
  });

  it("clamps maxChars into [1, DOC_TEXT_MAX_CHARS]", () => {
    const full = "z".repeat(DOC_TEXT_MAX_CHARS + 1000);
    expect(pageDocumentText(REL, full, 0, 0).returned).toBe(1);                 // floored up to 1
    expect(pageDocumentText(REL, full, 0, -10).returned).toBe(1);
    expect(pageDocumentText(REL, full, 0, 9_999_999).returned).toBe(DOC_TEXT_MAX_CHARS); // capped
  });

  it("treats an offset past the end as a clean empty tail, not an error", () => {
    const full = "short";
    const page = pageDocumentText(REL, full, 1000, 50);
    expect(page).toMatchObject({ offset: 5, returned: 0, total: 5, nextOffset: null, text: "" });
  });

  it("clamps a negative offset to the start", () => {
    const page = pageDocumentText(REL, "hello world", -5, 5);
    expect(page.offset).toBe(0);
    expect(page.text).toBe("hello");
  });
});
