// ── kg-recipes · lc — label validation + first-of-kind template derivation ───
// Focuses on the cross-cutting InstructionalRoutine: a curator can author a
// routine via add_nodes even in a graph that holds none yet (reading before its
// first routine), the same way maths — which already carries routines — always
// could. deriveTemplate's no-example fallback must yield a FAITHFUL routine
// skeleton (PascalCase kind, routine role), so a first inline routine looks like
// a seeded one.
import { describe, it, expect } from "vitest";
import { deriveTemplate, isKnownLabel } from "../lc.js";
import type { MutationGraph } from "../../kg-store/index.js";

// A graph with no routine node — the reading-before-its-first-routine case.
const routineless: MutationGraph = {
  nodes: [{ id: "les-1", type: "Lesson", namespace: "ns", labels: ["Lesson"], spine: true, properties: { raw: {} } }],
  edges: [],
};

describe("isKnownLabel", () => {
  it("accepts InstructionalRoutine even when the graph has none to copy", () => {
    expect(isKnownLabel(routineless, "InstructionalRoutine")).toBe(true);
  });

  it("still rejects a label that is neither canonical nor present", () => {
    expect(isKnownLabel(routineless, "Widget")).toBe(false);
  });
});

describe("deriveTemplate — first-of-kind InstructionalRoutine", () => {
  it("yields a faithful routine skeleton (PascalCase kind, routine role, no normalizedType)", () => {
    const template = deriveTemplate(routineless, "InstructionalRoutine");
    // Canonical kind is the label verbatim — NOT the lowercased default that
    // would leave a routine as "instructionalroutine" and mismatch seeded ones.
    expect(template.kind).toBe("InstructionalRoutine");
    expect(template.labels).toEqual(["InstructionalRoutine"]);
    expect(template.isGrouping).toBe(false);
    expect(template.role).toBe("instructional-routine"); // matches assembleCatalog's routine nodes
    expect(template.normalizedType).toBeUndefined();     // seeded routines carry none
  });
});
