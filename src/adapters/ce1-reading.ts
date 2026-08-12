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
// carried in a standard's statement_type — the reading-specific `detect` signal.
// Scope B surfaces ALL nine teachable standard types (these six plus the
// oral/reading ones — Expression orale / Lecture / Récitation), each taught by
// one or more of the week's daily sessions, so the read projection no longer
// filters to the six.
const STRAND_TYPES = new Set(["Conjugaison", "Vocabulaire", "Orthographe", "Grammaire", "Écriture / Copie", "Production d'écrits"]);

// Weeks NOT produced with this prompt: integration weeks close each palier
// (9, 17, 24) and week 25 is the end-of-year evaluation.
const NON_GUIDE_WEEKS = new Set([9, 17, 24, 25]);

const DELIVERABLES: DeliverableSpec[] = [
  { key: "teacher_guide", label: "Guide de l'enseignant·e (teacher guide)", scopeKind: "week", classify: () => true, dependsOn: [], promptFile: "PROMPT_generate_lessons.md" },
];

// ── Typed accessors over the raw passthrough (unit.properties) ────────────────
type Meta = { role?: string; palier?: number | null; genre?: string | null };
const meta = (u: CurriculumUnit): Meta => (u.properties.metadata as Meta) ?? {};
const strandOf = (u: CurriculumUnit): string | null => (u.properties.statementType as string) ?? null;

// A session Lesson's teaching-schedule metadata (day/order/language/…), authored
// onto the content Lesson by the Scope B migration.
type SessionMeta = { day?: number; order_in_day?: number; session_order?: number; language?: string; duration?: string; session_category?: string };
const sessionMeta = (u: CurriculumUnit): SessionMeta => (u.properties.metadata as SessionMeta) ?? {};

// ── Raw envelope → CurriculumModel ──────────────────────────────────────────
// Post content-layer step (graph-native authoring, Scope B): the week is a
// content `LessonGrouping` (LABEL) but keeps kind `week` (its natural meaning —
// role wins over label). Each of the week's 22 daily sessions is a content
// `Lesson` that `supports` the spine `expectation` it teaches (many sessions →
// one standard; Remédiation supports none). Weeks 1–8 oral/comprehension/poetry
// sessions align to the shared palier-1 combined standards, which live under a
// separate non-numeric "1 à 8" grouping.
const READING_PARSE: GraphParseDescriptor = {
  roleToKind: { week: "week", expectation: "expectation" },
  labelToKind: { Lesson: "lesson", LearningComponent: "component" },
  numberFrom: "description", // week number is a bare-number description
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
      for (const cid of g.childIds) if (byId.get(cid)?.kind === "lesson") keep.add(cid);
    }
    // Expectations a kept session supports (session→supports→expectation ⇒
    // expectation.childIds ∋ the session).
    for (const ex of units) {
      if (ex.kind !== "expectation") continue;
      const supported = ex.childIds.some((cid) => byId.get(cid)?.kind === "lesson" && keep.has(cid));
      if (supported) keep.add(ex.id);
    }
    for (const u of units) if (u.kind === "component") { const p = byId.get(u.parentId ?? ""); if (p && keep.has(p.id)) keep.add(u.id); }
    return units.filter((u) => keep.has(u.id));
  },
};

function detect(raw: unknown): boolean {
  const g = raw as { nodes?: unknown[]; relationships?: unknown[] } | undefined;
  if (!Array.isArray(g?.nodes) || !Array.isArray(g?.relationships)) return false;
  // Reading-specific signal: a language-tool strand standard.
  return g!.nodes.some((n: any) => STRAND_TYPES.has(n?.properties?.statementType) && n?.properties?.normalizedStatementType === "Standard");
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
  // number (= normalized `order`, from the bare-number description). The
  // non-numeric "1 à 8" grouping (which only holds the palier-1 combined
  // standards, no sessions) has a null order and is filtered out here — it is a
  // container of standards, not a guide week. palier and genre are read from the
  // grouping's baked metadata — no tree-walk.
  const groupingsIn = (m: CurriculumModel) =>
    m.unitsOfKind("week").filter((w) => w.order != null).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const weeks = () => groupingsIn(ensure());
  const weekOf = (m: CurriculumModel, wk: number) => groupingsIn(m).find((w) => w.order === wk) ?? null;
  const listUnitsIn = (m: CurriculumModel) =>
    groupingsIn(m).map((w) => ({ semaine: w.order, palier: meta(w).palier ?? null, genre: meta(w).genre ?? null }));

  // A content session Lesson supports (at most) one expectation — the standard it
  // teaches; the parser records that as expectation.childIds ∋ the Lesson.
  const standardOfLesson = (m: CurriculumModel) => {
    const map = new Map<string, CurriculumUnit>();
    for (const ex of m.unitsOfKind("expectation"))
      for (const child of m.childrenOf(ex.id)) if (child.kind === "lesson") map.set(child.id, ex);
    return map;
  };

  // The week's 22 daily sessions, in timetable order, each with the standard it
  // teaches (or null for Remédiation). Walk grouping → session Lesson →
  // (supports) → standard; the session's day/language/duration ride its metadata.
  const buildSlice = (wk: number, m: CurriculumModel = ensure()) => {
    const week = weekOf(m, wk);
    if (!week) return null;
    const stdOf = standardOfLesson(m);
    const sessions = m.childrenOf(week.id)
      .filter((c) => c.kind === "lesson")
      .sort((a, b) => (sessionMeta(a).session_order ?? 0) - (sessionMeta(b).session_order ?? 0))
      .map((ln) => {
        const sm = sessionMeta(ln);
        const std = stdOf.get(ln.id) ?? null;
        return {
          jour: sm.day ?? null,
          seance: sm.order_in_day ?? null,
          ordre: sm.session_order ?? null,
          titre: ln.text,
          langue: sm.language ?? null,
          duree: sm.duration ?? null,
          categorie: sm.session_category ?? null,
          standard: std
            ? {
                type: strandOf(std),
                osTexte: std.text,
                statementCode: (std.properties.statementCode as string) ?? null,
                components: m.childrenOf(std.id).filter((c) => c.kind === "component").map((c) => ({ identifier: c.id, description: c.text })),
              }
            : null,
        };
      });
    return {
      semaine: wk,
      palier: meta(week).palier ?? null,
      genre: meta(week).genre ?? null,
      sessions,
    };
  };

  // The distinct standards a week teaches across its sessions (deduped — several
  // sessions may teach the same standard), the coverage a guide must honour.
  const coverageOf = (wk: number, m: CurriculumModel = ensure()) => {
    const slice = buildSlice(wk, m);
    if (!slice) return [];
    const seen = new Set<string>();
    const out: { type: string | null; osTexte: string | null }[] = [];
    for (const s of slice.sessions) {
      if (!s.standard) continue;
      const key = `${s.standard.type}|${s.standard.osTexte}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: s.standard.type, osTexte: s.standard.osTexte });
    }
    return out;
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
    requiredCoverage: (scope) => coverageOf(Number(scope)),
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
        requiredCoverage: curriculumSlice ? coverageOf(week, m) : [],
        establishedCharacters, recentThemes,
        terminology: { note: "Session titles and metalinguistic terms come from the KG's own bilingual wording; when a term's wording is missing, search the MOHEBS FR/Wolof terminology via get_terminology and use that (Wolof for L1 sessions, French for L2). Do not invent wording.", sections: terminologySections() },
        coverage, notes,
      };
    },
  };
}
