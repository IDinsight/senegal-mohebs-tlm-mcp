/*
 * Store-backed namespace enumeration + the namespace⇄context round-trip.
 *
 * The store is the source of truth for WHICH graphs exist: listNamespaces()
 * returns every namespace with a pointer, and parseNamespace() recovers the
 * teaching context from a namespace key (filtering the reserved catalog
 * partitions). Together they let context discovery come from the store instead
 * of an on-disk sources/ scan. Pure, no Firestore — the memory store mirrors the
 * pointer model exactly.
 */
import { describe, it, expect } from "vitest";
import { createMemoryKgStore, kgNamespace, parseNamespace } from "../index.js";
import { catalogNamespace, SHARED_CATALOG_NAMESPACE } from "../../kg-recipes/index.js";

describe("store.listNamespaces", () => {
  it("returns only namespaces that have a pointer (seeded), not bare-read ones", async () => {
    const store = createMemoryKgStore();
    const seeded = kgNamespace("senegal", "ci", "maths");
    await store.ensurePointer(seeded, "a");
    // A bare read lazily creates an empty namespace entry — it must NOT count as
    // installed, since it was never seeded/imported.
    await store.readPointer(kgNamespace("senegal", "ce1", "reading"));

    expect(await store.listNamespaces()).toEqual([seeded]);
  });
});

describe("parseNamespace", () => {
  it("recovers workspace/grade/subject from a curriculum namespace", () => {
    const ns = kgNamespace("senegal", "ci", "maths");
    expect(parseNamespace(ns)).toEqual({ workspace: "senegal", grade: "ci", subject: "maths" });
  });

  it("rejects the reserved catalog partitions (workspace + shared)", () => {
    expect(parseNamespace(catalogNamespace("senegal"))).toBeNull();
    expect(parseNamespace(SHARED_CATALOG_NAMESPACE)).toBeNull();
  });

  it("rejects the reserved glossary partition (so it isn't a selectable context)", () => {
    expect(parseNamespace(kgNamespace("senegal", "_glossary", "terms"))).toBeNull();
  });

  it("rejects anything that isn't a 3-segment namespace", () => {
    expect(parseNamespace("senegal/ci")).toBeNull();
    expect(parseNamespace("a/b/c/d")).toBeNull();
  });

  it("round-trips kgNamespace for a curriculum context", () => {
    const ctx = { workspace: "nigeria", grade: "primary-1-3", subject: "maths" };
    expect(parseNamespace(kgNamespace(ctx.workspace, ctx.grade, ctx.subject))).toEqual(ctx);
  });
});
