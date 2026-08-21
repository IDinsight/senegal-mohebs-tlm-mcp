/*
 * The LexiconEntry ↔ node round-trip and the small pure helpers around it.
 */
import { describe, it, expect } from "vitest";
import {
  buildLexiconNode, parseEntry, normalizeRenderings, hasAnyRendering,
  primaryRendering, mergeEntry, isLexiconNode,
} from "../model.js";

describe("glossary model", () => {
  it("normalizes renderings: trims, drops blanks, lowercases language codes", () => {
    expect(normalizeRenderings({ FR: " compter ", wo: "", EN: "count" })).toEqual({ fr: "compter", en: "count" });
    expect(hasAnyRendering({ fr: "" })).toBe(false);
    expect(hasAnyRendering({ fr: "compter" })).toBe(true);
  });

  it("picks French as the primary rendering, else the first available", () => {
    expect(primaryRendering({ wo: "waññ", fr: "compter" })).toBe("compter");
    expect(primaryRendering({ wo: "waññ" })).toBe("waññ");
  });

  it("round-trips an entry through a node (renderings + narrowing + example in the sidecar)", () => {
    const input = { renderings: { fr: "compter", wo: "waññ" }, subject: "maths", example: "Compte jusqu'à 10.", tags: ["nombres"] };
    const node = buildLexiconNode(input, "id-1", "senegal/_glossary/terms");

    expect(isLexiconNode(node)).toBe(true);
    expect(node.labels).toEqual(["LexiconEntry"]);
    expect(node.properties.text).toBe("compter"); // display headword mirrored out
    expect((node.properties.metadata as Record<string, unknown>).renderings).toEqual({ fr: "compter", wo: "waññ" });

    const back = parseEntry(node);
    expect(back).toMatchObject({ id: "id-1", renderings: { fr: "compter", wo: "waññ" }, subject: "maths", example: "Compte jusqu'à 10.", tags: ["nombres"] });
  });

  it("merges an edit: renderings merge key-by-key, other fields replace", () => {
    const current = { id: "id-1", renderings: { fr: "compter", wo: "waññ" }, subject: "maths" };
    const merged = mergeEntry(current, { renderings: { wo: "waññ-v2", en: "count" }, subject: "reading" });
    expect(merged.renderings).toEqual({ fr: "compter", wo: "waññ-v2", en: "count" });
    expect(merged.subject).toBe("reading");
  });

  it("drops a language when the merge supplies a blank value", () => {
    const current = { id: "id-1", renderings: { fr: "compter", wo: "waññ" } };
    const merged = mergeEntry(current, { renderings: { wo: "" } });
    expect(merged.renderings).toEqual({ fr: "compter" });
  });
});
