// ── Module: adapters · CI maths ───────────────────────────────────────────────
// The single per-subject adapter module for CI maths. Behavior only: no schema,
// no LC property/edge/cardinality declarations, no integrity rules. Storage
// round-trip lives in curriculum/store-bridge.ts and runs on the parsed
// CurriculumModel (subject-agnostic).
//
// The source graph is now the CONVERGED `{ nodes, relationships }` envelope with
// the LC metadata scheme (normalized_statement_type = container/leaf,
// metadata.role = fine role, metadata.order = number, statement_type = category
// on leaves, description = text/title). Parsing is delegated to the generic
// `parseGraph`; this module only supplies the descriptor and the read-time
// projection. The two axes — schedule (week→OS) and content (domaine→chapter→OS)
// — are read through the edges (childrenOf), never a denormalized number.
import { readFileSync } from "node:fs";
import { CONFIG, kgSource } from "../config.js";
import { sourcePath, sessionState } from "../context/index.js";
import { listEntries } from "../storage/index.js";
import { neighborhoodDomains, suggestFreshDomain, domainUsage } from "../generation/index.js";
import { parseGraph, terminologySections, PRELOADED_MODEL_KEY, emptyContainerWarnings, type GraphParseDescriptor } from "../curriculum/index.js";
import { noAccents } from "../utils/index.js";
import type {
  SubjectAdapter, DeliverableSpec, CharacterRef,
  CurriculumModel, CurriculumUnit, GraphView,
} from "../types.js";

const ADAPTER_ID = "ci-maths/nodes-relationships-v1";

// Teacher guide filenames contain "fiche(s) de leçon"; everything else is the
// pupil manual. Mutually exclusive, so discovery matches exactly one deliverable.
const isLessons = (filename: string) => noAccents(filename).includes("fiches de lecons") || noAccents(filename).includes("fiche de lecon");

const DELIVERABLES: DeliverableSpec[] = [
  { key: "manual", label: "Manuel de l'élève (pupil book)", scopeKind: "chapter", classify: (f) => !isLessons(f), dependsOn: [], promptFile: "PROMPT_generate_chapter.md" },
  { key: "lessons", label: "Fiches de leçons (teacher guide)", scopeKind: "chapter", classify: isLessons, dependsOn: ["manual"], promptFile: "PROMPT_generate_lessons.md" },
];

// ── Small typed accessors over the raw passthrough (unit.properties) ──────────
type Meta = { role?: string; order?: number; en?: Record<string, any> };
const meta = (u: CurriculumUnit): Meta => (u.properties.metadata as Meta) ?? {};
const rawStr = (u: CurriculumUnit, k: string): string | null => (u.properties[k] as string) ?? null;

// ── Raw envelope → CurriculumModel ──────────────────────────────────────────
// Delegated to the generic parser; the descriptor is all that is subject-specific.
// The bilan (end-of-chapter assessment) is the one raw quirk that needs a hook:
// per chapter, the last lesson whose text mentions "bilan", else the last lesson.
const MATHS_PARSE: GraphParseDescriptor = {
  roleToKind: {
    week: "week",
    subtopic: "chapter",
    strand: "domaine",
    expectation: "lesson",
    "intégration du palier": "lesson",
  },
  labelToKind: { LearningComponent: "component", Curriculum: "task" },
  numberFrom: "order",
  progressionEdge: "buildsTowards",
  postParse: (units) => {
    const byId = new Map(units.map((u) => [u.id, u]));
    for (const c of units) {
      if (c.kind !== "chapter") continue;
      const lessons = c.childIds
        .map((id) => byId.get(id))
        .filter((u): u is CurriculumUnit => !!u && u.kind === "lesson")
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const bilan = [...lessons].reverse().find((l) => /bilan/i.test(String(l.text ?? ""))) ?? lessons[lessons.length - 1];
      if (bilan) bilan.isAssessment = true;
    }
  },
};

function detect(raw: unknown): boolean {
  const g = raw as { nodes?: unknown[]; relationships?: unknown[] } | undefined;
  if (!Array.isArray(g?.nodes) || !Array.isArray(g?.relationships)) return false;
  // Maths-specific signal: a chapter grouping (a `Chapitre` with role "subtopic").
  return g!.nodes.some((n: any) => n?.properties?.statement_type === "Chapitre" && n?.properties?.metadata?.role === "subtopic");
}

function parse(raw: unknown): CurriculumModel {
  return parseGraph(raw, MATHS_PARSE);
}

// ── Coverage / consistency warnings (#13) ────────────────────────────────────
// Simplified by the convergence: chapter→lesson is now a real `hasChild` edge, so
// the whole chapitreNum-drift machinery is gone. Two rules remain: a chapter with
// no lessons (generic), and a chapter with 0 or >1 bilan. NOTE: multiParentWarnings
// is deliberately NOT applied to lessons — a lesson legitimately has TWO parents
// now (its week on the schedule axis, its chapter on the content axis).
const HAS_CHILD = "hasChild";
function ciMathsCoverageWarnings(graph: GraphView): string[] {
  const warnings: string[] = [];
  warnings.push(...emptyContainerWarnings(graph, ["chapter"]));

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // chapter→lesson children via the content backbone edge, and the count of
  // CHAPTER parents per lesson. A lesson legitimately has one chapter parent
  // (content axis) and one week parent (schedule axis) — so we count only chapter
  // parents; >1 is the genuine ambiguity (the generic multi-parent rule can't be
  // used here because every lesson has two parents by design).
  const childLessonsByChapter = new Map<string, GraphView["nodes"]>();
  const chapterParents = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type !== HAS_CHILD) continue;
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || from.type !== "chapter" || !to || to.type !== "lesson") continue;
    (childLessonsByChapter.get(e.from) ?? childLessonsByChapter.set(e.from, []).get(e.from)!).push(to);
    chapterParents.set(e.to, (chapterParents.get(e.to) ?? 0) + 1);
  }
  for (const [lessonId, count] of chapterParents) {
    if (count <= 1) continue;
    const l = byId.get(lessonId)!;
    warnings.push(`Coverage: lesson '${(l.properties.text as string) ?? lessonId}' has ${count} chapter parents — a lesson belongs to exactly one chapter (its week is a separate axis). Detach it from all but one.`);
  }
  for (const c of graph.nodes) {
    if (c.type !== "chapter") continue;
    const lessons = childLessonsByChapter.get(c.id) ?? [];
    if (lessons.length === 0) continue; // covered by emptyContainerWarnings
    const bilans = lessons.filter((l) => l.properties.isAssessment === true).length;
    const label = (c.properties.title as string) ?? c.id;
    if (bilans === 0) warnings.push(`Coverage: chapter '${label}' has ${lessons.length} lesson(s) but no bilan (end-of-chapter assessment). Mark one lesson as the bilan before publishing.`);
    else if (bilans > 1) warnings.push(`Coverage: chapter '${label}' has ${bilans} bilan lessons — exactly one is expected.`);
  }
  return warnings;
}

// ── Factory: build the (grade, subject)-bound adapter ────────────────────────
export function buildCiMathsAdapter(grade: string, subject: string): SubjectAdapter {
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

  // Read helpers, all parametrized by the CurriculumModel they read (published via
  // ensure(); a draft-resolved model for preview). Chapter→lesson and week→lesson
  // are followed through the EDGES (childrenOf), not any number.
  const chaptersIn = (m: CurriculumModel) => m.unitsOfKind("chapter");
  const chapters = () => chaptersIn(ensure());
  const chapterOf = (m: CurriculumModel, chapNum: number) => chaptersIn(m).find((c) => c.order === chapNum) ?? null;
  const domaineOf = (m: CurriculumModel, chapter: CurriculumUnit) => m.byId.get(chapter.parentId ?? "")?.title ?? null;
  const lessonsOf = (m: CurriculumModel, chapter: CurriculumUnit) =>
    m.childrenOf(chapter.id).filter((u) => u.kind === "lesson").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // lesson id → its week number (schedule axis).
  const weekMap = (m: CurriculumModel) => {
    const map = new Map<string, number | null>();
    for (const w of m.unitsOfKind("week")) for (const l of m.childrenOf(w.id)) if (l.kind === "lesson") map.set(l.id, w.order);
    return map;
  };

  const listUnitsIn = (m: CurriculumModel) =>
    chaptersIn(m)
      .map((c) => ({ chapitreNum: c.order, chapitreTitre: c.title, domaine: domaineOf(m, c) }))
      .sort((a, b) => (a.chapitreNum ?? 0) - (b.chapitreNum ?? 0));

  const buildSlice = (chapNum: number, m: CurriculumModel = ensure()) => {
    const chapter = chapterOf(m, chapNum);
    if (!chapter) return null;
    const lessonUnits = lessonsOf(m, chapter);
    const weekOf = weekMap(m);
    const bilanId = lessonUnits.find((l) => l.isAssessment)?.id ?? null;

    const lessons = lessonUnits.map((ln) => {
      const components = m.childrenOf(ln.id).filter((c) => c.kind === "component").map((cn) => ({
        identifier: cn.id,
        description: cn.text ?? null,
        description_en: meta(cn).en?.description ?? null,
        reference: rawStr(cn, "reference"),
        tasks: m.childrenOf(cn.id).filter((t) => t.kind === "task").map((tn) => ({
          identifier: tn.id,
          description: tn.text ?? null,
          contentType: rawStr(tn, "content_type"),
        })),
      }));
      return {
        identifier: ln.id, leconNum: ln.order ?? null, osTexte: ln.text ?? null,
        statementType: meta(ln).role ?? null, statementCode: rawStr(ln, "statement_code"),
        semaine: weekOf.get(ln.id) ?? null, palier: (ln.properties.palier as number) ?? null,
        isBilan: ln.isAssessment, components,
      };
    });
    return {
      chapitreNum: chapNum,
      chapitreTitre: chapter.title ?? null,
      domaine: domaineOf(m, chapter),
      lessons, bilanLessonId: bilanId,
    };
  };

  const buildProgression = (chapNum: number, m: CurriculumModel = ensure()) => {
    const chapterUnit = chapterOf(m, chapNum);
    if (!chapterUnit) return { buildsTowards: [] as number[], buildsFrom: [] as number[] };
    const numOf = (id: string) => m.byId.get(id)?.order ?? undefined;
    return {
      buildsTowards: chapterUnit.buildsTowards.map(numOf).filter((n): n is number => n != null),
      buildsFrom: chapterUnit.buildsFrom.map(numOf).filter((n): n is number => n != null),
    };
  };

  return {
    grade, subject,
    id: ADAPTER_ID,
    deliverables: DELIVERABLES,
    capabilities: { exampleDomainRotation: true, characterConsistency: true },

    // Wording paths a curator may edit via upsert_property (#10). In the store a
    // node's normalized field (title/text) and its raw source (raw.description)
    // hold the same wording; declare both so one call keeps them in sync. English
    // wording now lives under raw.metadata.en.*.
    wordingAliases: {
      chapter: {
        title:    ["title", "raw.description"],
        title_en: ["raw.metadata.en.description"],
      },
      lesson: {
        text:    ["text", "raw.description", "raw.os_texte"],
        text_en: ["raw.metadata.en.description", "raw.metadata.en.os_texte"],
      },
      component: {
        text:    ["text", "raw.description"],
        text_en: ["raw.metadata.en.description"],
      },
      task: {
        text:    ["text", "raw.description"],
        text_en: ["raw.metadata.en.description"],
      },
    },

    // Structural keys the recipes (#14) may edit. The chapitreNum join key is
    // GONE — chapter→lesson is the hasChild edge now — so `lesson.chapterNumber`
    // is dropped. A number lives in BOTH the normalized `order` and its raw
    // mirror `raw.metadata.order`.
    structuralAliases: {
      chapter: {
        number:   ["order", "raw.metadata.order"],
      },
      lesson: {
        position: ["order", "raw.metadata.order"],
      },
    },

    recipeProfile: {
      chapterKind: "chapter",
      lessonKind: "lesson",
      containerEdge: "hasChild",
      assessmentProperty: "isAssessment",
    },

    coverageWarnings: ciMathsCoverageWarnings,

    detect, parse,

    listUnits: () => listUnitsIn(ensure()),
    slice: (scope) => buildSlice(Number(scope)),
    progression: (scope) => buildProgression(Number(scope)),
    requiredCoverage: (scope) => {
      const s = buildSlice(Number(scope));
      return s ? s.lessons.filter((l) => !l.isBilan).map((l) => ({ leconNum: l.leconNum, osTexte: l.osTexte })) : [];
    },
    scopeValues: () => chapters().map((c) => c.order).filter((n): n is number => n != null).sort((a, b) => a - b),

    async buildGenerationContext(scope, deliverableKey, model) {
      const m = model ?? ensure();
      const chapter = Number(scope);
      const docType = deliverableKey;
      const notes: string[] = [];
      const entries = await listEntries();

      // Aggregate established characters by name; earliest chapter wins, details merge.
      const charMap = new Map<string, { name: string; type?: string; role?: string; description?: string; firstChapter: number }>();
      for (const e of entries) {
        for (const raw of e.content.characters ?? []) {
          const c: CharacterRef = typeof raw === "string" ? { name: raw } : raw;
          if (!c?.name) continue;
          const existing = charMap.get(c.name);
          if (!existing) charMap.set(c.name, { name: c.name, type: c.type, role: c.role, description: c.description, firstChapter: e.chapter });
          else {
            existing.firstChapter = Math.min(existing.firstChapter, e.chapter);
            existing.type ??= c.type; existing.role ??= c.role; existing.description ??= c.description;
          }
        }
      }
      const establishedCharacters = [...charMap.values()].sort((a, b) => a.firstChapter - b.firstChapter || a.name.localeCompare(b.name));

      const coverage = listUnitsIn(m).map((c) => ({
        chapter: c.chapitreNum,
        hasManual: entries.some((e) => e.chapter === c.chapitreNum && e.type === "manual"),
        hasLessons: entries.some((e) => e.chapter === c.chapitreNum && e.type === "lessons"),
      }));

      const manualForThisChapter = entries.find((e) => e.id === `${chapter}:manual`) ?? null;
      if (docType === "lessons" && !manualForThisChapter) notes.push(`No pupil manual is tracked for chapter ${chapter}. Lesson sheets build on the manual — generate or ingest the manual first.`);

      const curriculumSlice = buildSlice(chapter, m);
      if (!curriculumSlice) notes.push(`Chapter ${chapter} was not found in the knowledge graph.`);
      const requiredLessonCoverage = curriculumSlice
        ? curriculumSlice.lessons.filter((l) => !l.isBilan).map((l) => ({ leconNum: l.leconNum, osTexte: l.osTexte }))
        : [];

      return {
        unit: chapter, deliverable: docType, curriculum: curriculumSlice, progression: buildProgression(chapter, m), requiredLessonCoverage,
        establishedCharacters,
        exampleDomains: await (async () => {
          const avoidNearby = await neighborhoodDomains(chapter);
          const suggested = await suggestFreshDomain(avoidNearby);
          return { suggested, avoidNearby };
        })(),
        terminology: { note: "Glossary derives from the KG's own wording; when a term's wording is missing, search the MOHEBS FR/Wolof terminology via get_terminology and use that. Do not invent wording.", sections: terminologySections() },
        coverage, manualForThisChapter, notes,
      };
    },

    suggestFreshDomain: () => suggestFreshDomain(),
    domainUsage: () => domainUsage(),
  };
}
