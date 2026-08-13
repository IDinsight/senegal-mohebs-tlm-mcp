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
import { CONFIG } from "../config.js";
import { subjectDir } from "../context/index.js";
import { resolveAdapter } from "../adapters/index.js";
import { serializeModel, toRawEnvelope } from "./index.js";
import { kgNamespace } from "../kg-store/index.js";

type RawNode = { id: string; labels?: string[]; properties?: Record<string, unknown> };
type RawRel = { id: string; type: string; start: string; end: string; properties?: Record<string, unknown> };

const CASES = [
  // maths: post two-Course split + canonical chapter▸lesson▸activity nesting, weeks
  // as LessonGrouping, and the RECE illustrative activities de-linked from their
  // frame (−104 off-canon SFI→Activity hasChild; they keep hasEducationalAlignment).
  { grade: "ci", subject: "maths", nodes: 746, edges: 1145 },
  // reading: post content-layer, Scope B — 462 session Lesson nodes (22/week ×
  // 21 guide weeks), 462 week→session hasChild edges, 441 session→standard
  // supports edges (all sessions but Remédiation).
  { grade: "ce1", subject: "reading", nodes: 1968, edges: 2244 },
];

const edgeKey = (e: { type: string; start: string; end: string }) => `${e.type}|${e.start}|${e.end}`;
const bag = (keys: string[]) => { const m = new Map<string, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return m; };

describe("faithful re-export — the store reproduces the source LC graph", () => {
  for (const c of CASES) {
    it(`${c.grade}/${c.subject}: every node + edge round-trips (${c.nodes} nodes, ${c.edges} edges)`, () => {
      const raw = JSON.parse(readFileSync(resolve(subjectDir(c.grade, c.subject), CONFIG.kgFile), "utf8")) as { nodes: RawNode[]; relationships: RawRel[] };
      const adapter = resolveAdapter(c.grade, c.subject)!;
      const stored = serializeModel(adapter.parse(raw), kgNamespace(c.grade, c.subject));
      const out = toRawEnvelope(stored);

      // Counts match the source exactly — nothing dropped.
      expect(out.nodes.length).toBe(c.nodes);
      expect(out.nodes.length).toBe(raw.nodes.length);
      expect(out.relationships.length).toBe(c.edges);
      expect(out.relationships.length).toBe(raw.relationships.length);

      // Every source node survives with identical labels + properties.
      const outById = new Map(out.nodes.map((n) => [n.id, n]));
      expect(new Set(outById.keys())).toEqual(new Set(raw.nodes.map((n) => n.id)));
      for (const src of raw.nodes) {
        const got = outById.get(src.id)!;
        expect(got.labels).toEqual(src.labels ?? []);
        expect(got.properties).toEqual(src.properties ?? {});
      }

      // Every source edge survives (by type + endpoints), same multiset.
      expect(bag(out.relationships.map(edgeKey))).toEqual(bag(raw.relationships.map(edgeKey)));

      // And the previously-dropped cross-links are actually present now.
      const byType = new Map<string, number>();
      for (const e of out.relationships) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
      const srcByType = new Map<string, number>();
      for (const e of raw.relationships) srcByType.set(e.type, (srcByType.get(e.type) ?? 0) + 1);
      expect(byType).toEqual(srcByType);
      if ((srcByType.get("supports") ?? 0) > 0) expect(byType.get("supports")).toBe(srcByType.get("supports"));
    });
  }
});
