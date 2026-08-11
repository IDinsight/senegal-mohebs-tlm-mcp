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
function chapterUnderDomaine(g: MutationGraph): { chapterId: string; domaineTitle: string } {
  for (const e of g.edges) {
    if (e.type !== "hasChild") continue;
    const from = g.nodes.find((n) => n.id === e.from);
    const to = g.nodes.find((n) => n.id === e.to);
    if (from?.type === "domaine" && to?.type === "chapter") {
      return { chapterId: to.id, domaineTitle: String((from.properties as { title?: unknown }).title) };
    }
  }
  throw new Error("no domaine→chapter edge in the seed");
}

const at = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

describe("LC fidelity — labels round-trip", () => {
  it("preserves top-level labels through parse → serialize → deserialize", () => {
    const g = seedGraph();
    // The seed's spine nodes are StandardsFrameworkItem — parse+serialize kept it.
    const chapter = g.nodes.find((n) => n.type === "chapter")!;
    expect(chapter.labels).toEqual(["StandardsFrameworkItem"]);

    // And the round-trip back out of the store shape keeps it byte-stable.
    const reserialized = serializeModel(deserializeToModel(g), ns);
    const same = reserialized.nodes.find((n) => n.id === chapter.id)!;
    expect(same.labels).toEqual(["StandardsFrameworkItem"]);
  });
});

describe("LC fidelity — recipe-created nodes are faithful LC nodes", () => {
  it("stamps role / normalized_statement_type / labels and inherits the domaine strand", () => {
    const g = seedGraph();
    const { chapterId, domaineTitle } = chapterUnderDomaine(g);

    const after = addLesson.apply(g, {
      namespace: ns, profile: adapter.recipeProfile!, structuralAliases: adapter.structuralAliases!,
      wordingAliases: adapter.wordingAliases, lcNodeTemplate: adapter.lcNodeTemplate,
      chapterId, lessonId: "lc-fidelity-new-lesson", text: "objectif de test",
    });

    const lesson = after.nodes.find((n) => n.id === "lc-fidelity-new-lesson")!;
    expect(lesson).toBeDefined();
    expect(lesson.labels).toEqual(["StandardsFrameworkItem"]);
    expect(at(lesson.properties, "raw.metadata.role")).toBe("expectation");
    expect(at(lesson.properties, "raw.normalized_statement_type")).toBe("Standard");
    // The strand is a denormalized copy of the domaine the chapter sits under.
    expect(at(lesson.properties, "raw.statement_type")).toBe(domaineTitle);
  });

  it("survives a re-parse through the LC parser as a lesson (does not get dropped)", () => {
    const g = seedGraph();
    const { chapterId } = chapterUnderDomaine(g);
    const after = addLesson.apply(g, {
      namespace: ns, profile: adapter.recipeProfile!, structuralAliases: adapter.structuralAliases!,
      wordingAliases: adapter.wordingAliases, lcNodeTemplate: adapter.lcNodeTemplate,
      chapterId, lessonId: "lc-fidelity-reparse", text: "objectif de test",
    });
    const lesson = after.nodes.find((n) => n.id === "lc-fidelity-reparse")!;

    // Export the stored node back to a raw LC node: {id, labels, properties:raw}.
    const rawLcNode = { id: lesson.id, labels: lesson.labels, properties: at(lesson.properties, "raw") };
    const reparsed = adapter.parse({ nodes: [rawLcNode], relationships: [] });

    // kindOf reads metadata.role → "expectation" → "lesson". Before Part 2 the
    // node had no role and this returned nothing (node silently dropped).
    expect(reparsed.byId.get("lc-fidelity-reparse")?.kind).toBe("lesson");
  });
});
