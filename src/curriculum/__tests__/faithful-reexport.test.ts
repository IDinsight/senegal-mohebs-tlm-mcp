/*
 * Faithful re-export: the store round-trips to the source LC graph
 *
 * The whole point of full-graph storage is that Firestore can REPLACE the source
 * knowledge_graph.json. This guards that: parse → serializeModel (store shape) →
 * toRawEnvelope reproduces EVERY node and EVERY edge of the source — same ids,
 * labels, properties, and edge (type, endpoints) — including the framework/
 * derived nodes and the supports/relatesTo cross-links that used to be dropped.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { CONFIG } from "../../config.js";
import { subjectDir } from "../../context/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel, toRawEnvelope } from "../index.js";
import { kgNamespace } from "../../kg-store/index.js";

type RawNode = { id: string; labels?: string[]; properties?: Record<string, unknown> };
type RawRel = { id: string; type: string; start: string; end: string; properties?: Record<string, unknown> };

const CASES = [
  // maths: post two-Course split + canonical chapter▸lesson▸activity nesting, weeks
  // as LessonGrouping, and the RECE illustrative activities de-linked from their
  // frame (−104 off-canon SFI→Activity hasChild; they keep hasEducationalAlignment).
  // +11 nodes / +10 edges: the shared "fiche de leçon" instructional routine
  // (1 parent + 5 step InstructionalRoutine + 5 Material; parent→steps→Material
  // via hasPart — see graph-native-authoring.md).
  // +112 edges: each of the 112 Teacher's-Guide Lessons usesRoutine the parent
  // (the routine is NOT linked from the Course — only lessons use it).
  // +13 nodes / +37 edges: the pupil-manual "structure d'un chapitre" routine
  // (1 parent + 6 step InstructionalRoutine + 6 Material; parent→steps→Material
  // via 12 hasPart) + 25 usesRoutine from each Student's-Book container Lesson
  // (metadata.role studentBookLesson) — the manual template is per-lesson, canonical.
  // +6 nodes / +6 edges: three formatter InstructionalRoutine+Material subtrees
  // (house style, art style, illustration layout) attached to the Student's-Book Course
  // via use_formatter — each 1 InstructionalRoutine + 1 Material + 1 hasPart + 1
  // usesRoutine-from-Course. Exported back into sources so a re-seed keeps them.
  { workspace: "senegal", grade: "ci", subject: "maths", nodes: 776, edges: 1310 },
  // reading: post content-layer, Scope B — 462 session Lesson nodes (22/week ×
  // 21 guide weeks), 462 week→session hasChild edges, 441 session→standard
  // supports edges (all sessions but Remédiation).
  { workspace: "senegal", grade: "ce1", subject: "reading", nodes: 1968, edges: 2244 },
];

const edgeKey = (edge: { type: string; start: string; end: string }) => `${edge.type}|${edge.start}|${edge.end}`;
const bag = (keys: string[]) => {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

describe("faithful re-export — the store reproduces the source LC graph", () => {
  for (const testCase of CASES) {
    it(`${testCase.grade}/${testCase.subject}: every node + edge round-trips (${testCase.nodes} nodes, ${testCase.edges} edges)`, () => {
      const raw = JSON.parse(readFileSync(resolve(subjectDir(testCase.workspace, testCase.grade, testCase.subject), CONFIG.kgFile), "utf8")) as { nodes: RawNode[]; relationships: RawRel[] };
      const adapter = resolveAdapter(testCase.grade, testCase.subject)!;
      const stored = serializeModel(adapter.parse(raw), kgNamespace(testCase.grade, testCase.subject));
      const out = toRawEnvelope(stored);

      // Counts match the source exactly — nothing dropped.
      expect(out.nodes.length).toBe(testCase.nodes);
      expect(out.nodes.length).toBe(raw.nodes.length);
      expect(out.relationships.length).toBe(testCase.edges);
      expect(out.relationships.length).toBe(raw.relationships.length);

      // Every source node survives with identical labels + properties.
      const outById = new Map(out.nodes.map((node) => [node.id, node]));
      expect(new Set(outById.keys())).toEqual(new Set(raw.nodes.map((node) => node.id)));
      for (const src of raw.nodes) {
        const got = outById.get(src.id)!;
        expect(got.labels).toEqual(src.labels ?? []);
        expect(got.properties).toEqual(src.properties ?? {});
      }

      // Every source edge survives (by type + endpoints), same multiset.
      expect(bag(out.relationships.map(edgeKey))).toEqual(bag(raw.relationships.map(edgeKey)));

      // And the previously-dropped cross-links are actually present now.
      const byType = new Map<string, number>();
      for (const edge of out.relationships) byType.set(edge.type, (byType.get(edge.type) ?? 0) + 1);
      const srcByType = new Map<string, number>();
      for (const edge of raw.relationships) srcByType.set(edge.type, (srcByType.get(edge.type) ?? 0) + 1);
      expect(byType).toEqual(srcByType);
      if ((srcByType.get("supports") ?? 0) > 0) expect(byType.get("supports")).toBe(srcByType.get("supports"));
    });
  }
});
