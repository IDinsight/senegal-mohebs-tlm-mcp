/*
 * Module: adapters · Nigeria maths (Primary 1–3)
 *
 * The per-subject adapter for the NERDC "9-Year Basic Education Mathematics
 * Curriculum for Primary 1-3" — an EIDU/Learning-Commons export. It is a
 * standards graph (no Lesson/Activity/Material, no documents to generate); it
 * exists to be browsed.
 *
 * Two layers, both read straight from canonical LC fields:
 *   - the SPINE: Grade → Theme → Sub-Theme → Topic → { Performance Objective,
 *     Content }, distinguished by `statementType` (this dialect has no
 *     `metadata.role` sidecar and a single StandardsFrameworkItem label). Each
 *     Topic carries TWO kinds of leaf standard — the objectives and the content
 *     descriptors that sit beside them in the NERDC tables.
 *   - the COMPONENT layer: `LearningComponent` nodes attached to a leaf standard
 *     via `supports` (the parser's default supportEdge), surfaced under that leaf.
 *
 * There is no ordinal field, so `numberFrom` is omitted and sequence is a
 * deterministic text sort (storage-independent — see `cmp`). The framework root
 * has no statementType and is dropped as scaffolding, leaving the three Grade
 * nodes as the model roots.
 *
 * Read projection: a browsable "unit" is a THEME (15 across the three grades);
 * `slice(themeNum)` walks its Sub-Theme → Topic → {objectives, content} subtree,
 * each leaf carrying its components. No deliverables, progression, or coverage —
 * a reference framework has nothing to generate or complete.
 */
import { parseGraph, type GraphParseDescriptor } from "../curriculum/index.js";
import { makeEnsure, detectEnvelope } from "./engine.js";
import type { SubjectAdapter, DeliverableSpec, CurriculumModel } from "../types.js";

const ADAPTER_ID = "nigeria-maths/lc-graph-v2";

// No documents are produced from a standards reference framework.
const DELIVERABLES: DeliverableSpec[] = [];

// LC-native parse. Level comes from `statementType`; the LearningComponent layer
// has no statementType, so it is keyed by its LC label. `supports` (component →
// leaf) is the parser's default supportEdge, so components fold in as children of
// the leaf they support. No ordinal field → `numberFrom` omitted.
const NIGERIA_PARSE: GraphParseDescriptor = {
  roleToKind: {},
  statementTypeToKind: {
    Grade: "grade",
    Theme: "theme",
    "Sub-Theme": "subtheme",
    Topic: "topic",
    "Performance Objective": "objective",
    Content: "content",
  },
  labelToKind: { LearningComponent: "component" },
};

function parse(raw: unknown): CurriculumModel {
  return parseGraph(raw, NIGERIA_PARSE);
}

export function buildNigeriaMathsAdapter(grade: string, subject: string): SubjectAdapter {
  const ensure = makeEnsure(parse);

  return {
    grade, subject,
    id: ADAPTER_ID,
    deliverables: DELIVERABLES,
    capabilities: { exampleDomainRotation: false, characterConsistency: false },

    // Curators may correct wording: a leaf's statement `text` (objective, content,
    // or component) or any grouping's `title`. Each edits the normalized field and
    // its raw LC mirror (`raw.description`) atomically. English-only — no `_en`.
    wordingAliases: {
      objective: { text: ["text", "raw.description"] },
      content: { text: ["text", "raw.description"] },
      component: { text: ["text", "raw.description"] },
      grade: { title: ["title", "raw.description"] },
      theme: { title: ["title", "raw.description"] },
      subtheme: { title: ["title", "raw.description"] },
      topic: { title: ["title", "raw.description"] },
    },

    detect: detectEnvelope, parse,
    model: ensure,
  };
}
