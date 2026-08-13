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
import { listEntries } from "../storage/index.js";
import { parseGraph, terminologySections, emptyContainerWarnings, multiParentWarnings, type GraphParseDescriptor } from "../curriculum/index.js";
import { makeEnsure, detectEnvelope, aggregateCharacters, alignedStandardOf } from "./engine.js";
import type {
  SubjectAdapter, DeliverableSpec,
  CurriculumModel, CurriculumUnit, GraphView,
} from "../types.js";

const ADAPTER_ID = "ce1-reading/nodes-relationships-v1";

// Reading's only editable wording shape: normalized `text` + its raw source.
const TEXT_ONLY = { text: ["text", "raw.description"] };

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

// ── Content layer (Scope C) — Activity/Material read projections ──────────────
// An Activity's canonical LC props (grouping/time/use) and a Material's payload
// live under the raw passthrough (unit.properties === the raw LC properties).
const materialsUnder = (m: CurriculumModel, parentId: string) =>
  m.childrenOf(parentId)
    .filter((c) => c.kind === "material")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((mat) => ({
      titre: mat.text,
      type: (mat.properties.materialType as string) ?? "Core",
      contenu: (mat.properties.content as string) ?? null,
    }));

const activitiesUnder = (m: CurriculumModel, lessonId: string) =>
  m.childrenOf(lessonId)
    .filter((c) => c.kind === "activity")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((act) => ({
      titre: act.text,
      groupement: (act.properties.studentGroupingType as string) ?? null,
      duree: (act.properties.timeRequired as string) ?? null,
      usage: (act.properties.educationalUse as string) ?? null,
      ordre: act.order ?? null,
      materials: materialsUnder(m, act.id),
    }));

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

  // The week's 22 daily sessions, in timetable order, each with the standard it
  // teaches (or null for Remédiation). Walk grouping → session Lesson →
  // (supports) → standard; the session's day/language/duration ride its metadata.
  const buildSlice = (wk: number, m: CurriculumModel = ensure()) => {
    const week = weekOf(m, wk);
    if (!week) return null;
    const stdOf = alignedStandardOf(m); // session lesson → the standard it teaches
    // Sessions live one level down now: week → Jour(1–5) day grouping → session.
    const sessions = m.childrenOf(week.id)
      .filter((c) => c.kind === "day")
      .flatMap((d) => m.childrenOf(d.id).filter((c) => c.kind === "lesson"))
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
          // Content layer (Scope C): the session's authored Activities (one per
          // Étape, in order) each with their Material(s), plus any Material
          // attached to the session itself (e.g. the shared reading text). Empty
          // until the sessions are authored via add_activity / add_material.
          activities: activitiesUnder(m, ln.id),
          materials: materialsUnder(m, ln.id),
        };
      });
    return {
      semaine: wk,
      palier: meta(week).palier ?? null,
      genre: meta(week).genre ?? null,
      // Week-level Materials (e.g. an opening-scene image for the whole week),
      // attached to the week grouping via hasPart. Empty until authored.
      materials: materialsUnder(m, week.id),
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
      const establishedCharacters = aggregateCharacters(entries);

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
