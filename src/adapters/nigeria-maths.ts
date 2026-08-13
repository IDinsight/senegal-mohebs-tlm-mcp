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
import type {
  SubjectAdapter, DeliverableSpec,
  CurriculumModel, CurriculumUnit,
} from "../types.js";

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

// gradeLevel is inconsistent across this export: a real array (`["primary two"]`),
// a legacy JSON-string (`"[\"2\"]"`), mixed case, stray punctuation
// (`["PRIMARY: THREE"]`), or empty. Extract 1/2/3 from a leading digit or the
// words one/two/three; NaN when absent (sorts stably to the end).
function gradeLevelOf(u?: CurriculumUnit): number {
  const raw = u?.properties?.gradeLevel as unknown;
  let first: unknown;
  if (Array.isArray(raw)) first = raw[0];
  else if (typeof raw === "string") {
    try { const p = JSON.parse(raw); first = Array.isArray(p) ? p[0] : p; } catch { first = raw; }
  } else first = raw;
  if (first == null) return NaN;
  const s = String(first).toLowerCase();
  const digit = s.match(/\d+/);
  if (digit) return Number(digit[0]);
  if (/\bone\b/.test(s)) return 1;
  if (/\btwo\b/.test(s)) return 2;
  if (/\bthree\b/.test(s)) return 3;
  return NaN;
}

export function buildNigeriaMathsAdapter(grade: string, subject: string): SubjectAdapter {
  const ensure = makeEnsure(parse);

  // Deterministic, STORAGE-INDEPENDENT ordering. The source has no ordinal and
  // the Firestore round-trip does not preserve edge (child) insertion order, so
  // ordering by traversal would diverge between the bundle and firestore read
  // paths (breaking parity:kg-store). We sort on the node's own wording, with the
  // id as a stable tiebreak — identical whichever backend served the graph.
  const cmp = (a: CurriculumUnit, b: CurriculumUnit) =>
    (a.title ?? a.text ?? "").localeCompare(b.title ?? b.text ?? "") || a.id.localeCompare(b.id);

  // A theme's grade level: read from its parent Grade node, falling back to the
  // theme's own gradeLevel when the parent's is missing/unparseable.
  const themeGradeLevel = (m: CurriculumModel, theme: CurriculumUnit): number => {
    const viaParent = gradeLevelOf(m.byId.get(theme.parentId ?? ""));
    return Number.isNaN(viaParent) ? gradeLevelOf(theme) : viaParent;
  };

  // Themes ordered by grade level first (Primary 1 → 3), then by the shared
  // comparator within a grade. The 1-based index into this list is the theme's
  // scope value, since the source carries no theme number of its own.
  const orderedThemes = (m: CurriculumModel): CurriculumUnit[] =>
    [...m.unitsOfKind("theme")].sort((a, b) => {
      const ga = themeGradeLevel(m, a), gb = themeGradeLevel(m, b);
      const ka = Number.isNaN(ga) ? Infinity : ga, kb = Number.isNaN(gb) ? Infinity : gb;
      return ka - kb || cmp(a, b);
    });

  const themeByNum = (m: CurriculumModel, num: number): CurriculumUnit | null => orderedThemes(m)[num - 1] ?? null;
  const gradeUnitOf = (m: CurriculumModel, theme: CurriculumUnit) => m.byId.get(theme.parentId ?? "") ?? null;
  const childrenOfKind = (m: CurriculumModel, id: string, kind: string) =>
    m.childrenOf(id).filter((u) => u.kind === kind).sort(cmp);

  // Tally distinct descendants of a theme by kind. A LearningComponent may support
  // more than one leaf (so appear under two parents); a visited set keeps the
  // count honest.
  const descendantCounts = (m: CurriculumModel, rootId: string) => {
    const counts = { objective: 0, content: 0, component: 0 } as Record<string, number>;
    const seen = new Set<string>();
    const stack = m.childrenOf(rootId).map((u) => u.id);
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const u = m.byId.get(id);
      if (!u) continue;
      if (u.kind in counts) counts[u.kind]++;
      stack.push(...u.childIds);
    }
    return counts;
  };

  const componentsOf = (m: CurriculumModel, leaf: CurriculumUnit) =>
    childrenOfKind(m, leaf.id, "component").map((c) => ({ identifier: c.id, text: c.text }));

  const gradeFacts = (m: CurriculumModel, theme: CurriculumUnit) => ({
    grade: gradeUnitOf(m, theme)?.title ?? null,
    gradeLevel: themeGradeLevel(m, theme) || null,
  });

  const listUnitsIn = (m: CurriculumModel) =>
    orderedThemes(m).map((t, i) => {
      const c = descendantCounts(m, t.id);
      return {
        themeNum: i + 1,
        ...gradeFacts(m, t),
        theme: t.title,
        subThemes: childrenOfKind(m, t.id, "subtheme").length,
        objectives: c.objective,
        content: c.content,
        components: c.component,
      };
    });

  // A theme's Sub-Theme → Topic subtree. Each Topic carries both its Performance
  // Objectives and its Content descriptors; each leaf carries its components.
  const buildSlice = (themeNum: number, m: CurriculumModel = ensure()) => {
    const theme = themeByNum(m, themeNum);
    if (!theme) return null;
    const leaf = (l: CurriculumUnit) => ({ identifier: l.id, text: l.text, components: componentsOf(m, l) });
    return {
      themeNum,
      ...gradeFacts(m, theme),
      theme: theme.title,
      subThemes: childrenOfKind(m, theme.id, "subtheme").map((st) => ({
        subTheme: st.title,
        topics: childrenOfKind(m, st.id, "topic").map((tp) => ({
          topic: tp.title,
          objectives: childrenOfKind(m, tp.id, "objective").map(leaf),
          content: childrenOfKind(m, tp.id, "content").map(leaf),
        })),
      })),
    };
  };

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

    listUnits: () => listUnitsIn(ensure()),
    slice: (scope) => buildSlice(Number(scope)),
    // No progression edges in the source; nothing builds toward anything.
    progression: () => ({ buildsTowards: [], buildsFrom: [] }),
    // No deliverables → nothing to "cover".
    requiredCoverage: () => [],
    scopeValues: () => orderedThemes(ensure()).map((_, i) => i + 1),

    // A standards reference framework generates no documents; return the
    // curriculum slice with an explicit note rather than pretend there is one.
    async buildGenerationContext(scope, deliverableKey, model) {
      const m = model ?? ensure();
      const theme = Number(scope);
      const curriculum = buildSlice(theme, m);
      const notes = [
        "This is a standards reference framework (NERDC Primary 1–3). It has no deliverables — no pupil manual or lesson sheets are generated from it.",
        ...(curriculum ? [] : [`Theme ${theme} was not found in the knowledge graph.`]),
      ];
      return { unit: theme, deliverable: deliverableKey, curriculum, notes };
    },
  };
}
