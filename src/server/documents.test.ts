// ── list_documents pagination — pageDocuments() paging contract ──────────────
// pageDocuments is the pure paging over the already-(chapter asc, type asc)-sorted
// history. These tests pin the limit + opaque-cursor contract without standing up
// storage: default/clamped limits, walking pages via nextCursor with no overlap or
// gaps, a null nextCursor on the final page, and a rejected bad cursor.
import { describe, it, expect } from "vitest";
import { pageDocuments } from "./documents.js";
import type { HistoryEntry } from "../types.js";

// Minimal entries in listEntries() order: (chapter asc, then type asc). Two
// deliverables per chapter exercise the tie-break on `type`.
function entry(chapter: number, type: string): HistoryEntry {
  return {
    id: `${chapter}:${type}`,
    chapter,
    type: type as HistoryEntry["type"],
    relPath: `chapitre_${chapter}/${type}.docx`,
    md5: "x", updated: "", source: "pipeline", recordedAt: "", content: {},
  };
}

// 10 chapters × { lessons, manual } = 20 entries, already sorted the way
// listEntries() returns them (type sorts "lessons" < "manual").
const ALL: HistoryEntry[] = Array.from({ length: 10 }, (_, i) => i + 1).flatMap(
  (c) => [entry(c, "lessons"), entry(c, "manual")]
);

// Type guard so the tests read cleanly past the {error} union arm.
function ok(r: ReturnType<typeof pageDocuments>) {
  if ("error" in r) throw new Error(`expected a page, got error: ${r.error}`);
  return r;
}

describe("pageDocuments", () => {
  it("defaults to a 25-item page and reports the true total", () => {
    const r = ok(pageDocuments(ALL, {}));
    expect(r.total).toBe(20);
    expect(r.count).toBe(20);         // fewer than the 25 default → single page
    expect(r.nextCursor).toBeNull();
    expect(r.entries[0].id).toBe("1:lessons");
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
      const r = ok(pageDocuments(ALL, { cursor: cursor ?? undefined, limit: 6 }));
      seen.push(...r.entries.map((e) => e.id));
      cursor = r.nextCursor;
      if (++guard > 100) throw new Error("pagination did not terminate");
    } while (cursor != null);

    // Exactly the full set, in order, each id once.
    expect(seen).toEqual(ALL.map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("returns a non-null cursor only while more remains", () => {
    const first = ok(pageDocuments(ALL, { limit: 18 }));
    expect(first.count).toBe(18);
    expect(first.nextCursor).not.toBeNull();

    const last = ok(pageDocuments(ALL, { cursor: first.nextCursor!, limit: 18 }));
    expect(last.count).toBe(2);
    expect(last.nextCursor).toBeNull();      // remainder < limit → final page
    expect(last.entries.map((e) => e.id)).toEqual(["10:lessons", "10:manual"]);
  });

  it("orders the tie-break on type after the numeric chapter (10 after 2)", () => {
    // The cursor carries {chapter,type}, not the lexical id — so paging past
    // chapter 2 must still surface chapter 10 later, never before it.
    const idx10 = ALL.findIndex((e) => e.id === "10:lessons");
    const idx2 = ALL.findIndex((e) => e.id === "2:lessons");
    expect(idx2).toBeLessThan(idx10);
  });

  it("rejects a malformed cursor rather than silently restarting", () => {
    const r = pageDocuments(ALL, { cursor: "not-a-real-cursor" });
    expect("error" in r && r.error).toContain("Invalid cursor");
  });

  it("treats an absent cursor as the first page", () => {
    const r = ok(pageDocuments(ALL, { limit: 3 }));
    expect(r.entries[0].id).toBe("1:lessons");
    expect(r.count).toBe(3);
  });

  it("filters by chapter, narrowing total but keeping totalUnfiltered", () => {
    const r = ok(pageDocuments(ALL, { chapter: 3 }));
    expect(r.entries.map((e) => e.id)).toEqual(["3:lessons", "3:manual"]);
    expect(r.total).toBe(2);              // the filtered set
    expect(r.totalUnfiltered).toBe(20);   // the whole history
    expect(r.nextCursor).toBeNull();
  });

  it("filters by type across all chapters", () => {
    const r = ok(pageDocuments(ALL, { type: "manual", limit: 100 }));
    expect(r.count).toBe(10);
    expect(r.entries.every((e) => e.type === "manual")).toBe(true);
    expect(r.total).toBe(10);
  });

  it("combines chapter + type to a single entry", () => {
    const r = ok(pageDocuments(ALL, { chapter: 7, type: "lessons" }));
    expect(r.entries.map((e) => e.id)).toEqual(["7:lessons"]);
    expect(r.total).toBe(1);
  });

  it("paginates WITHIN a filtered set without leaking other chapters", () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let guard = 0;
    do {
      const r = ok(pageDocuments(ALL, { type: "manual", cursor: cursor ?? undefined, limit: 4 }));
      seen.push(...r.entries.map((e) => e.id));
      cursor = r.nextCursor;
      if (++guard > 50) throw new Error("did not terminate");
    } while (cursor != null);
    expect(seen).toEqual(ALL.filter((e) => e.type === "manual").map((e) => e.id));
    expect(seen.every((id) => id.endsWith(":manual"))).toBe(true);
  });

  it("returns an empty page (not an error) when a filter matches nothing", () => {
    const r = ok(pageDocuments(ALL, { chapter: 999 }));
    expect(r.count).toBe(0);
    expect(r.total).toBe(0);
    expect(r.nextCursor).toBeNull();
  });
});
