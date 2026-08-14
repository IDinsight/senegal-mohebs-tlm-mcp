/*
 * Module: adapters · CE1 reading
 *
 * The single per-subject adapter module for CE1 reading. Behavior only. The
 * source graph is the converged `{ nodes, relationships }` envelope with the LC
 * metadata scheme, cleaned in Phase 1 (twin weeks deduped; palier + genre baked
 * onto each week under metadata). Parsing is delegated to the shared generic
 * `parseGraph`; this module supplies only the descriptor and the read-time
 * projection. A "unit" is a WEEK (semaine); its slice is the week's six
 * language-tool standards (the "outils de langue") with their components.
 */
import { parseGraph, emptyContainerWarnings, multiParentWarnings, type GraphParseDescriptor } from "../curriculum/index.js";
import { makeEnsure, detectEnvelope } from "./engine.js";
import type { SubjectAdapter, DeliverableSpec, CurriculumModel, GraphView } from "../types.js";

const ADAPTER_ID = "ce1-reading/nodes-relationships-v1";

// Reading's only editable wording shape: normalized `text` + its raw source.
const TEXT_ONLY = { text: ["text", "raw.description"] };

const DELIVERABLES: DeliverableSpec[] = [
  { key: "teacher_guide", label: "Guide de l'enseignant·e (teacher guide)", scopeKind: "week", classify: () => true, dependsOn: [], promptFile: "PROMPT_generate_lessons.md" },
];

// ── Raw envelope → CurriculumModel ──────────────────────────────────────────
// Post content-layer step (graph-native authoring, Scope B): the week is a
// content `LessonGrouping` (LABEL) but keeps kind `week` (its natural meaning —
// role wins over label). Each of the week's 22 daily sessions is a content
// `Lesson` that `supports` the spine `expectation` it teaches (many sessions →
// one standard; Remédiation supports none). Weeks 1–8 oral/comprehension/poetry
// sessions align to the shared palier-1 combined standards, which live under a
// separate non-numeric "1 à 8" grouping.
const READING_PARSE: GraphParseDescriptor = {
  roleToKind: { week: "week", day: "day", expectation: "expectation" },
  labelToKind: { Lesson: "lesson", LearningComponent: "component", Activity: "activity", Material: "material" },
  numberFrom: "position", // canonical LC: week/day number is the grouping's `position`
  // Spine-scope. Keep the weeks (groupings), their session lessons, every
  // expectation those sessions support (all nine teachable types now, not just
  // the six language tools), and their components; drop the rest (orphans). This
  // just keeps the store lean.
  postParse: (units) => {
    const byId = new Map(units.map((u) => [u.id, u]));
    const keep = new Set<string>();
    for (const g of units) {
      if (g.kind !== "week") continue;
      keep.add(g.id);
      // A week holds Jour 1–5 `day` groupings, each holding the session lessons.
      for (const cid of g.childIds) {
        const child = byId.get(cid);
        if (child?.kind === "day") { keep.add(cid); for (const lid of child.childIds) if (byId.get(lid)?.kind === "lesson") keep.add(lid); }
        else if (child?.kind === "lesson") keep.add(cid); // pre-day-layer fallback
      }
    }
    // Expectations a kept session supports (session→supports→expectation ⇒
    // expectation.childIds ∋ the session).
    for (const ex of units) {
      if (ex.kind !== "expectation") continue;
      const supported = ex.childIds.some((cid) => byId.get(cid)?.kind === "lesson" && keep.has(cid));
      if (supported) keep.add(ex.id);
    }
    for (const u of units) if (u.kind === "component") { const p = byId.get(u.parentId ?? ""); if (p && keep.has(p.id)) keep.add(u.id); }
    // Content layer (Scope C): keep the Activities/Materials the content tree
    // hangs off any KEPT node via `hasPart` — an Activity under a session Lesson,
    // a Material under that Activity, or a Material attached directly to a kept
    // Lesson/day/week (session- or week-level content, e.g. an opening-scene
    // image). Closure over childIds adding ONLY content-layer kinds, so a
    // Material under an Activity (two levels down) is reached once its Activity is
    // kept. Restricted to activity/material kinds, so nothing else is pulled in.
    let changed = true;
    while (changed) {
      changed = false;
      for (const u of units) {
        if (!keep.has(u.id)) continue;
        for (const cid of u.childIds) {
          const c = byId.get(cid);
          if (c && (c.kind === "activity" || c.kind === "material") && !keep.has(cid)) { keep.add(cid); changed = true; }
        }
      }
    }
    return units.filter((u) => keep.has(u.id));
  },
};

function parse(raw: unknown): CurriculumModel {
  return parseGraph(raw, READING_PARSE);
}

// ── Factory: build the (grade, subject)-bound adapter ────────────────────────
export function buildCe1ReadingAdapter(grade: string, subject: string): SubjectAdapter {
  const ensure = makeEnsure(parse);

  return {
    grade, subject,
    id: ADAPTER_ID,
    deliverables: DELIVERABLES,
    capabilities: { exampleDomainRotation: false, characterConsistency: true },
    // Reading wording is text-only (no English mirror): the normalized `text` +
    // its `raw.description` source. Weeks carry none. For content nodes only the
    // TITLE is wording — a Material's `content` is edited via set_content, never
    // upsert_property.
    wordingAliases: {
      standard: TEXT_ONLY, component: TEXT_ONLY, activity: TEXT_ONLY, material: TEXT_ONLY,
    },

    // Coverage warnings (#13) — reading uses the subject-neutral shapes only. A
    // reading lesson/component has exactly one parent (unlike a maths lesson,
    // which has a week axis too), so multi-parent applies.
    coverageWarnings: (graph: GraphView): string[] => [
      ...emptyContainerWarnings(graph, ["week", "day"]),
      ...multiParentWarnings(graph, ["lesson", "component"]),
    ],

    detect: detectEnvelope, parse,
    model: ensure,
  };
}
