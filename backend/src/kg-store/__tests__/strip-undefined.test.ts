import { describe, it, expect } from "vitest";
import { stripUndefined } from "../firestore.js";

// Guards the fix for parked-payload writes: Firestore rejects any `undefined` in
// a document, and a parked confirm payload is the raw tool args, where an omitted
// optional (edit_node's `position`/`title`/…) is a literal `undefined`. Dropping
// those keys must be loss-free — an absent key reads back as `undefined`, which is
// what the downstream `args.x !== undefined` checks already expect.
describe("stripUndefined", () => {
  it("drops undefined-valued keys, like the edit_node args that hit Firestore", () => {
    const editNodeArgs = { nodeId: "n1", content: "hello", position: undefined, title: undefined, title_en: undefined };
    expect(stripUndefined(editNodeArgs)).toEqual({ nodeId: "n1", content: "hello" });
  });

  it("preserves falsy-but-defined values (0, empty string, false, null)", () => {
    const args = { a: 0, b: "", c: false, d: null, e: undefined };
    expect(stripUndefined(args)).toEqual({ a: 0, b: "", c: false, d: null });
  });

  it("recurses into nested objects and arrays (a batched add_nodes payload)", () => {
    const batch = { nodes: [{ label: "Lesson", position: 1, title: undefined }], meta: { note: undefined, keep: "x" } };
    expect(stripUndefined(batch)).toEqual({ nodes: [{ label: "Lesson", position: 1 }], meta: { keep: "x" } });
  });
});
