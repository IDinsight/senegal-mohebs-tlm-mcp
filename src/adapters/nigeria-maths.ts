/*
 * Module: adapters · Nigeria maths (Primary 1–3)
 *
 * The per-subject adapter for the NERDC "9-Year Basic Education Mathematics
 * Curriculum for Primary 1-3" — an EIDU/Learning-Commons export. Unlike the
 * senegal graphs this is a PURE STANDARDS SPINE: no content layer (no
 * Lesson/Activity/Material), no documents to generate. It exists to be browsed.
 *
 * The source is an LC-native dialect: every level is a single
 * `StandardsFrameworkItem` label with NO `metadata.role` sidecar and NO ordinal,
 * so the level is read from the canonical `statementType`
 * (Grade/Theme/Sub-Theme/Topic/Performance Objective) via the generic parser's
 * `statementTypeToKind`. Sequence comes from source/traversal order (there is no
 * number to sort on). The framework root has no statementType, so it is dropped
 * as scaffolding and the three Grade nodes become the model roots.
 *
 * Read projection: a browsable "unit" is a THEME (15 across the three grades).
 * `slice(themeNum)` walks the theme's Sub-Theme → Topic → Performance Objective
 * subtree. There are no deliverables, no progression, and no coverage rules — a
 * reference framework has nothing to generate or complete.
 */
import { parseGraph, type GraphParseDescriptor } from "../curriculum/index.js";
import { makeEnsure, detectEnvelope } from "./engine.js";
import type {
  SubjectAdapter, DeliverableSpec,
  CurriculumModel, CurriculumUnit,
} from "../types.js";

const ADAPTER_ID = "nigeria-maths/lc-spine-v1";

// No documents are produced from a standards-only framework.
const DELIVERABLES: DeliverableSpec[] = [];

// LC-native parse: level comes from `statementType` (no roles, one label), and
// there is no ordinal field, so `numberFrom` is omitted (order stays null and we
// read sequence from traversal order). Containment is all `hasChild`, covered by
// the parser's default containerEdge — no attachment/progression edges exist.
const NIGERIA_PARSE: GraphParseDescriptor = {
  roleToKind: {},
  statementTypeToKind: {
    Grade: "grade",
    Theme: "theme",
    "Sub-Theme": "subtheme",
    Topic: "topic",
    "Performance Objective": "objective",
  },
};

function parse(raw: unknown): CurriculumModel {
  return parseGraph(raw, NIGERIA_PARSE);
}

// gradeLevel is stored as a JSON-string array, e.g. `["2"]`. Read the first
// entry as a number; NaN when absent/unparseable (sorts stably to the end).
function gradeLevelOf(u: CurriculumUnit | undefined): number {
  try {
    const arr = JSON.parse(String(u?.properties?.gradeLevel ?? "[]"));
    const n = Number(Array.isArray(arr) ? arr[0] : arr);
    return Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
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

  // Themes ordered by grade level first (Primary 1 → 3), then by the shared
  // comparator within a grade. The 1-based index into this list is the theme's
  // scope value, since the source carries no theme number of its own.
  const orderedThemes = (m: CurriculumModel): CurriculumUnit[] =>
    [...m.unitsOfKind("theme")].sort((a, b) => {
      const ga = gradeLevelOf(m.byId.get(a.parentId ?? "")), gb = gradeLevelOf(m.byId.get(b.parentId ?? ""));
      const ka = Number.isNaN(ga) ? Infinity : ga, kb = Number.isNaN(gb) ? Infinity : gb;
      return ka - kb || cmp(a, b);
    });

  const themeByNum = (m: CurriculumModel, num: number): CurriculumUnit | null => orderedThemes(m)[num - 1] ?? null;
  const gradeUnitOf = (m: CurriculumModel, theme: CurriculumUnit) => m.byId.get(theme.parentId ?? "") ?? null;
  const childrenOfKind = (m: CurriculumModel, id: string, kind: string) =>
    m.childrenOf(id).filter((u) => u.kind === kind).sort(cmp);

  // All Performance Objectives beneath a theme, however deep — used for the count
  // in listUnits without assuming the exact nesting depth.
  const objectivesUnder = (m: CurriculumModel, rootId: string): CurriculumUnit[] => {
    const out: CurriculumUnit[] = [];
    const stack = [...m.childrenOf(rootId)];
    while (stack.length) {
      const u = stack.pop()!;
      if (u.kind === "objective") out.push(u);
      else stack.push(...m.childrenOf(u.id));
    }
    return out;
  };

  const gradeFacts = (m: CurriculumModel, theme: CurriculumUnit) => {
    const g = gradeUnitOf(m, theme);
    return { grade: g?.title ?? null, gradeLevel: gradeLevelOf(g ?? theme) || null };
  };

  const listUnitsIn = (m: CurriculumModel) =>
    orderedThemes(m).map((t, i) => ({
      themeNum: i + 1,
      ...gradeFacts(m, t),
      theme: t.title,
      subThemes: childrenOfKind(m, t.id, "subtheme").length,
      objectives: objectivesUnder(m, t.id).length,
    }));

  // A theme's full Sub-Theme → Topic → Performance Objective subtree. The nesting
  // is canonical (verified in the source), so the walk follows it level by level.
  const buildSlice = (themeNum: number, m: CurriculumModel = ensure()) => {
    const theme = themeByNum(m, themeNum);
    if (!theme) return null;
    return {
      themeNum,
      ...gradeFacts(m, theme),
      theme: theme.title,
      subThemes: childrenOfKind(m, theme.id, "subtheme").map((st) => ({
        subTheme: st.title,
        topics: childrenOfKind(m, st.id, "topic").map((tp) => ({
          topic: tp.title,
          objectives: childrenOfKind(m, tp.id, "objective").map((o) => ({ identifier: o.id, text: o.text })),
        })),
      })),
    };
  };

  return {
    grade, subject,
    id: ADAPTER_ID,
    deliverables: DELIVERABLES,
    capabilities: { exampleDomainRotation: false, characterConsistency: false },

    // Curators may correct wording: a leaf objective's statement `text`, or any
    // grouping's `title`. Each edits the normalized field and its raw LC mirror
    // (`raw.description`) atomically. This dialect is English-only — no `_en`.
    wordingAliases: {
      objective: { text: ["text", "raw.description"] },
      grade: { title: ["title", "raw.description"] },
      theme: { title: ["title", "raw.description"] },
      subtheme: { title: ["title", "raw.description"] },
      topic: { title: ["title", "raw.description"] },
    },

    detect: detectEnvelope, parse,

    listUnits: () => listUnitsIn(ensure()),
    slice: (scope) => buildSlice(Number(scope)),
    // No progression edges in the source; nothing builds toward anything.
    progression: () => ({ buildsTowards: [], buildsFrom: [] }),
    // No deliverables → nothing to "cover".
    requiredCoverage: () => [],
    scopeValues: () => orderedThemes(ensure()).map((_, i) => i + 1),

    // A standards-only framework generates no documents; return the curriculum
    // slice with an explicit note rather than pretend there is a deliverable.
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
