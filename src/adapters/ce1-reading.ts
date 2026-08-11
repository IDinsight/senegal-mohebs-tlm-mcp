// ── Module: adapters · CE1 reading ────────────────────────────────────────────
// The single per-subject adapter module for CE1 reading. Behavior only. The
// source graph is the converged `{ nodes, relationships }` envelope with the LC
// metadata scheme, cleaned in Phase 1 (twin weeks deduped; palier + genre baked
// onto each week under metadata). Parsing is delegated to the shared generic
// `parseGraph`; this module supplies only the descriptor and the read-time
// projection. A "unit" is a WEEK (semaine); its slice is the week's six
// language-tool standards (the "outils de langue") with their components.
import { readFileSync } from "node:fs";
import { CONFIG, kgSource } from "../config.js";
import { sourcePath, sessionState } from "../context/index.js";
import { listEntries } from "../storage/index.js";
import { parseGraph, terminologySections, PRELOADED_MODEL_KEY, emptyContainerWarnings, multiParentWarnings, type GraphParseDescriptor } from "../curriculum/index.js";
import type {
  SubjectAdapter, DeliverableSpec, CharacterRef,
  CurriculumModel, CurriculumUnit, GraphView,
} from "../types.js";

const ADAPTER_ID = "ce1-reading/nodes-relationships-v1";

// The six language-tool strands the KG scopes per week (the "outils de langue"),
// carried in a standard's statement_type. Weeks also hold oral/reading standards
// (Expression orale / Récitation / Lecture) which this teacher-guide deliverable
// does not cover — the projection filters to these six.
const STRAND_TYPES = new Set(["Conjugaison", "Vocabulaire", "Orthographe", "Grammaire", "Écriture / Copie", "Production d'écrits"]);
const STRAND_ORDER = ["Vocabulaire", "Grammaire", "Orthographe", "Conjugaison", "Production d'écrits", "Écriture / Copie"];

// Weeks NOT produced with this prompt: integration weeks close each palier
// (9, 17, 24) and week 25 is the end-of-year evaluation.
const NON_GUIDE_WEEKS = new Set([9, 17, 24, 25]);

const DELIVERABLES: DeliverableSpec[] = [
  { key: "teacher_guide", label: "Guide de l'enseignant·e (teacher guide)", scopeKind: "week", classify: () => true, dependsOn: [], promptFile: "PROMPT_generate_lessons.md" },
];

// ── Typed accessors over the raw passthrough (unit.properties) ────────────────
type Meta = { role?: string; palier?: number | null; genre?: string | null };
const meta = (u: CurriculumUnit): Meta => (u.properties.metadata as Meta) ?? {};
const strandOf = (u: CurriculumUnit): string | null => (u.properties.statement_type as string) ?? null;

// ── Raw envelope → CurriculumModel ──────────────────────────────────────────
// Post content-layer step (graph-native authoring, Scope A): the week is now a
// content `LessonGrouping` (LABEL) but keeps kind `week` (its natural meaning —
// role wins over label), and each language-tool objective is a content `Lesson`
// that `supports` its spine `expectation`. Reading thus gains the same content
// layer + LC labels as maths; its grouping stays a week rather than a chapter.
const READING_PARSE: GraphParseDescriptor = {
  roleToKind: { week: "week", expectation: "expectation" },
  labelToKind: { Lesson: "lesson", LearningComponent: "component" },
  numberFrom: "description", // week number is a bare-number description
  // Spine-scope. Keep the weeks (groupings), their lessons, the expectations those
  // lessons support (filtered to the six language-tool strands), and their
  // components; drop the rest (oral/reading standards, orphans). Reads stay
  // identical — this just keeps the store lean, exactly as before the content layer.
  postParse: (units) => {
    const byId = new Map(units.map((u) => [u.id, u]));
    const keep = new Set<string>();
    for (const g of units) {
      if (g.kind !== "week") continue;
      keep.add(g.id);
      for (const cid of g.childIds) if (byId.get(cid)?.kind === "lesson") keep.add(cid);
    }
    // Expectations a kept lesson supports (lesson→supports→expectation ⇒
    // expectation.childIds ∋ the lesson), filtered to the language-tool strands.
    for (const ex of units) {
      if (ex.kind !== "expectation") continue;
      const supported = ex.childIds.some((cid) => byId.get(cid)?.kind === "lesson" && keep.has(cid));
      if (supported && STRAND_TYPES.has(String(ex.properties.statement_type ?? ""))) keep.add(ex.id);
    }
    for (const u of units) if (u.kind === "component") { const p = byId.get(u.parentId ?? ""); if (p && keep.has(p.id)) keep.add(u.id); }
    return units.filter((u) => keep.has(u.id));
  },
};

function detect(raw: unknown): boolean {
  const g = raw as { nodes?: unknown[]; relationships?: unknown[] } | undefined;
  if (!Array.isArray(g?.nodes) || !Array.isArray(g?.relationships)) return false;
  // Reading-specific signal: a language-tool strand standard.
  return g!.nodes.some((n: any) => STRAND_TYPES.has(n?.properties?.statement_type) && n?.properties?.normalized_statement_type === "Standard");
}

function parse(raw: unknown): CurriculumModel {
  return parseGraph(raw, READING_PARSE);
}

// ── Factory: build the (grade, subject)-bound adapter ────────────────────────
export function buildCe1ReadingAdapter(grade: string, subject: string): SubjectAdapter {
  let model: CurriculumModel | null = null;
  const ensure = (): CurriculumModel => {
    if (model) return model;
    if (kgSource() === "firestore") {
      const preloaded = sessionState().bag.get(PRELOADED_MODEL_KEY) as CurriculumModel | undefined;
      if (!preloaded) throw new Error("KG_SOURCE=firestore but curriculum was not preloaded from the store. Call activateContext() first.");
      return (model = preloaded);
    }
    return (model = parse(JSON.parse(readFileSync(sourcePath(CONFIG.kgFile), "utf8"))));
  };

  // A week is a content `LessonGrouping` (label) of kind `week`, addressed by its
  // number (= normalized `order`, from the bare-number description). palier and
  // genre are read from the grouping's baked metadata — no tree-walk.
  const groupingsIn = (m: CurriculumModel) => m.unitsOfKind("week").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const weeks = () => groupingsIn(ensure());
  const weekOf = (m: CurriculumModel, wk: number) => groupingsIn(m).find((w) => w.order === wk) ?? null;
  const listUnitsIn = (m: CurriculumModel) =>
    groupingsIn(m).map((w) => ({ semaine: w.order, palier: meta(w).palier ?? null, genre: meta(w).genre ?? null }));

  // A content Lesson supports one expectation (the language-tool standard it
  // teaches); the parser records that as expectation.childIds ∋ the Lesson.
  const expectationOfLesson = (m: CurriculumModel) => {
    const map = new Map<string, CurriculumUnit>();
    for (const ex of m.unitsOfKind("expectation"))
      for (const child of m.childrenOf(ex.id)) if (child.kind === "lesson") map.set(child.id, ex);
    return map;
  };

  const buildSlice = (wk: number, m: CurriculumModel = ensure()) => {
    const week = weekOf(m, wk);
    if (!week) return null;
    const expOf = expectationOfLesson(m);
    // Walk grouping → Lesson → (supports) → language-tool standard, then emit the
    // same languageToolStandards shape the generation prompt consumes.
    const standards = m.childrenOf(week.id)
      .filter((c) => c.kind === "lesson")
      .map((ln) => expOf.get(ln.id))
      .filter((std): std is CurriculumUnit => !!std && STRAND_TYPES.has(strandOf(std) ?? ""))
      .sort((a, b) => STRAND_ORDER.indexOf(strandOf(a) ?? "") - STRAND_ORDER.indexOf(strandOf(b) ?? ""))
      .map((std) => ({
        strand: strandOf(std),
        osTexte: std.text,
        statementCode: (std.properties.statement_code as string) ?? null,
        components: m.childrenOf(std.id).filter((c) => c.kind === "component").map((c) => ({ identifier: c.id, description: c.text })),
      }));
    return {
      semaine: wk,
      palier: meta(week).palier ?? null,
      genre: meta(week).genre ?? null,
      languageToolStandards: standards,
    };
  };

  // Progression by week ordering across the weeks the KG carries (it skips
  // integration/evaluation weeks, so neighbours may not be wk±1).
  const buildProgression = (wk: number, m: CurriculumModel = ensure()) => {
    const nums = groupingsIn(m).map((w) => w.order as number);
    const i = nums.indexOf(wk);
    return {
      buildsFrom: i > 0 ? [nums[i - 1]] : [],
      buildsTowards: i >= 0 && i < nums.length - 1 ? [nums[i + 1]] : [],
    };
  };

  return {
    grade, subject,
    id: ADAPTER_ID,
    deliverables: DELIVERABLES,
    capabilities: { exampleDomainRotation: false, characterConsistency: true },
    // Reading's wording lives in `text` (normalized) + `raw.description` (source)
    // on strand standards and their components. Weeks carry no editable wording.
    wordingAliases: {
      standard: { text: ["text", "raw.description"] },
      component: { text: ["text", "raw.description"] },
    },

    // Coverage warnings (#13) — reading uses the subject-neutral shapes only. A
    // reading lesson/component has exactly one parent (unlike a maths lesson,
    // which has a week axis too), so multi-parent applies.
    coverageWarnings: (graph: GraphView): string[] => [
      ...emptyContainerWarnings(graph, ["week"]),
      ...multiParentWarnings(graph, ["lesson", "component"]),
    ],

    detect, parse,

    listUnits: () => listUnitsIn(ensure()),
    slice: (scope) => buildSlice(Number(scope)),
    progression: (scope) => buildProgression(Number(scope)),
    requiredCoverage: (scope) => {
      const s = buildSlice(Number(scope));
      return s ? s.languageToolStandards.map((st) => ({ strand: st.strand, osTexte: st.osTexte })) : [];
    },
    scopeValues: () => weeks().map((w) => w.order).filter((n): n is number => n != null),

    async buildGenerationContext(scope, deliverableKey, model) {
      const m = model ?? ensure();
      const week = Number(scope);
      const notes: string[] = [];
      const entries = await listEntries();

      // Aggregate recurring characters by name; earliest week wins, details merge.
      const charMap = new Map<string, { name: string; type?: string; role?: string; description?: string; firstWeek: number }>();
      for (const e of entries) {
        for (const raw of e.content.characters ?? []) {
          const c: CharacterRef = typeof raw === "string" ? { name: raw } : raw;
          if (!c?.name) continue;
          const existing = charMap.get(c.name);
          if (!existing) charMap.set(c.name, { name: c.name, type: c.type, role: c.role, description: c.description, firstWeek: e.unit });
          else {
            existing.firstWeek = Math.min(existing.firstWeek, e.unit);
            existing.type ??= c.type; existing.role ??= c.role; existing.description ??= c.description;
          }
        }
      }
      const establishedCharacters = [...charMap.values()].sort((a, b) => a.firstWeek - b.firstWeek || a.name.localeCompare(b.name));

      const recentThemes = [...entries]
        .filter((e) => e.unit !== week)
        .sort((a, b) => b.unit - a.unit)
        .flatMap((e) => (e.content.exampleDomains ?? []).map((t) => ({ theme: t, week: e.unit })));

      const coverage = listUnitsIn(m).map((w) => ({
        week: w.semaine,
        hasGuide: entries.some((e) => e.unit === w.semaine && e.type === "teacher_guide"),
      }));

      const curriculumSlice = buildSlice(week, m);
      if (!curriculumSlice) {
        notes.push(
          NON_GUIDE_WEEKS.has(week)
            ? `Semaine ${week} is an integration or evaluation week — it is produced with its own dedicated instructions, not this teacher-guide prompt. The knowledge graph carries no language-tool targets for it.`
            : `Semaine ${week} was not found in the knowledge graph.`,
        );
      }

      return {
        unit: week, deliverable: deliverableKey,
        curriculum: curriculumSlice, progression: buildProgression(week, m),
        requiredLanguageToolCoverage: curriculumSlice ? curriculumSlice.languageToolStandards.map((st) => ({ strand: st.strand, osTexte: st.osTexte })) : [],
        establishedCharacters, recentThemes,
        terminology: { note: "Session titles and metalinguistic terms come from the KG's own bilingual wording; when a term's wording is missing, search the MOHEBS FR/Wolof terminology via get_terminology and use that (Wolof for L1 sessions, French for L2). Do not invent wording.", sections: terminologySections() },
        coverage, notes,
      };
    },
  };
}
