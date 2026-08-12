// ── LC fidelity: labels round-trip + recipe-created nodes are faithful LC ─────
// Guards the "Firestore is a faithful, re-exportable Learning-Commons copy"
// invariant on two fronts:
//   1. Top-level `labels` survive the parse → serialize → deserialize round-trip
//      (they are dropped by neither store-bridge nor the parser).
//   2. A recipe-created node carries the LC identity fields (role /
//      normalized_statement_type / statement_type / labels), so it round-trips
//      through the LC parser as the RIGHT kind instead of being silently
//      dropped — the regression guard for Part 2's stamping.
// Pure parse/serialize/apply — no store, tokens, or async — so it never times out.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { CONFIG } from "../../config.js";
import { subjectDir } from "../../context/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel, deserializeToModel } from "../../curriculum/index.js";
import { addLesson, kgNamespace } from "../index.js";
import type { MutationGraph } from "../index.js";

const GRADE = "ci", SUBJECT = "maths";
const ns = kgNamespace(GRADE, SUBJECT);
const adapter = resolveAdapter(GRADE, SUBJECT)!;

// Base graph: the real CI-maths seed, parsed and serialized to the stored shape.
// LogicalNode (Omit<StoredNode,"slot">) === MutationNode, so this is a MutationGraph.
function seedGraph(): MutationGraph {
  const raw = JSON.parse(readFileSync(resolve(subjectDir(GRADE, SUBJECT), CONFIG.kgFile), "utf8"));
  const { nodes, edges } = serializeModel(adapter.parse(raw), ns);
  return { nodes, edges };
}

// A (chapter, its domaine title) pair — the content axis a lesson inherits its
// strand from. Every seeded chapter sits under exactly one domaine.
function chapterUnderDomaine(g: MutationGraph): { groupingId: string; domaineTitle: string } {
  for (const e of g.edges) {
    if (e.type !== "hasChild") continue;
    const from = g.nodes.find((n) => n.id === e.from);
    const to = g.nodes.find((n) => n.id === e.to);
    if (from?.type === "domaine" && to?.type === "chapter") {
      return { groupingId: to.id, domaineTitle: String((from.properties as { title?: unknown }).title) };
    }
  }
  throw new Error("no domaine→chapter edge in the seed");
}

const at = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

describe("LC fidelity — labels round-trip", () => {
  it("preserves top-level labels through parse → serialize → deserialize", () => {
    const g = seedGraph();
    // Post-split, a chapter is a content LessonGrouping; the point of this test is
    // that whatever labels a node carries survive parse+serialize unchanged.
    const chapter = g.nodes.find((n) => n.type === "chapter")!;
    expect(chapter.labels).toEqual(["LessonGrouping"]);

    // And the round-trip back out of the store shape keeps it byte-stable.
    const reserialized = serializeModel(deserializeToModel(g), ns);
    const same = reserialized.nodes.find((n) => n.id === chapter.id)!;
    expect(same.labels).toEqual(["LessonGrouping"]);
  });
});

// Any spine expectation a new lesson can align to.
const someExpectation = (g: MutationGraph): string => g.nodes.find((n) => n.type === "expectation")!.id;

describe("LC fidelity — recipe-created nodes are faithful LC nodes", () => {
  it("stamps the content-Lesson identity (labels / normalized_type) and aligns it to the expectation", () => {
    const g = seedGraph();
    const { groupingId } = chapterUnderDomaine(g);
    const expectationId = someExpectation(g);

    const after = addLesson.apply(g, {
      namespace: ns, profile: adapter.recipeProfile!, structuralAliases: adapter.structuralAliases!,
      wordingAliases: adapter.wordingAliases, lcNodeTemplate: adapter.lcNodeTemplate,
      groupingId, expectationId, lessonId: "lc-fidelity-new-lesson", text: "Titre de la leçon",
    });

    const lesson = after.nodes.find((n) => n.id === "lc-fidelity-new-lesson")!;
    expect(lesson).toBeDefined();
    // A content Lesson: real LC label + normalized_type, no objective/strand of
    // its own (those live on the aligned expectation).
    expect(lesson.labels).toEqual(["Lesson"]);
    expect(at(lesson.properties, "raw.normalizedType")).toBe("Lesson");
    expect(at(lesson.properties, "raw.metadata.role")).toBeUndefined();
    // It aligns to the standard via a hasEducationalAlignment edge (canonical LC coverage).
    expect(after.edges.some((e) => e.type === "hasEducationalAlignment" && e.from === "lc-fidelity-new-lesson" && e.to === expectationId)).toBe(true);
  });

  it("survives a re-parse through the LC parser as a lesson (does not get dropped)", () => {
    const g = seedGraph();
    const { groupingId } = chapterUnderDomaine(g);
    const after = addLesson.apply(g, {
      namespace: ns, profile: adapter.recipeProfile!, structuralAliases: adapter.structuralAliases!,
      wordingAliases: adapter.wordingAliases, lcNodeTemplate: adapter.lcNodeTemplate,
      groupingId, expectationId: someExpectation(g), lessonId: "lc-fidelity-reparse", text: "Titre de la leçon",
    });
    const lesson = after.nodes.find((n) => n.id === "lc-fidelity-reparse")!;

    // Export the stored node back to a raw LC node: {id, labels, properties:raw}.
    const rawLcNode = { id: lesson.id, labels: lesson.labels, properties: at(lesson.properties, "raw") };
    const reparsed = adapter.parse({ nodes: [rawLcNode], relationships: [] });

    // kindOf reads the [Lesson] label → kind "lesson". Before the split this node
    // carried role "expectation"; now the content Lesson is label-classified.
    expect(reparsed.byId.get("lc-fidelity-reparse")?.kind).toBe("lesson");
  });

  it("carries the bilan (assessment) flag as DATA through a re-parse", () => {
    // Regression guard for bilan-as-data: add_lesson's isBilan is stamped as
    // LC educational_use in raw and read back by the parser — before this the
    // parse-time regex ignored the authored flag entirely.
    const g = seedGraph();
    const { groupingId } = chapterUnderDomaine(g);
    const after = addLesson.apply(g, {
      namespace: ns, profile: adapter.recipeProfile!, structuralAliases: adapter.structuralAliases!,
      wordingAliases: adapter.wordingAliases, lcNodeTemplate: adapter.lcNodeTemplate,
      groupingId, expectationId: someExpectation(g), lessonId: "lc-fidelity-bilan", text: "Bilan", isBilan: true,
    });
    const lesson = after.nodes.find((n) => n.id === "lc-fidelity-bilan")!;
    expect(at(lesson.properties, "raw.educationalUse")).toBe("Assessment");

    const rawLcNode = { id: lesson.id, labels: lesson.labels, properties: at(lesson.properties, "raw") };
    const reparsed = adapter.parse({ nodes: [rawLcNode], relationships: [] });
    expect(reparsed.byId.get("lc-fidelity-bilan")?.isAssessment).toBe(true);
  });
});
