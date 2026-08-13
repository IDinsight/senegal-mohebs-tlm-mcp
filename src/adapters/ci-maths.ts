/*
 * Module: adapters · CI maths
 *
 * The single per-subject adapter module for CI maths. Behavior only: no schema,
 * no LC property/edge/cardinality declarations, no integrity rules. Storage
 * round-trip lives in curriculum/store-bridge.ts and runs on the parsed
 * CurriculumModel (subject-agnostic).
 *
 * The source graph is now the CONVERGED `{ nodes, relationships }` envelope with
 * the LC metadata scheme (normalized_statement_type = container/leaf,
 * metadata.role = fine role, metadata.order = number, statement_type = category
 * on leaves, description = text/title). Parsing is delegated to the generic
 * `parseGraph`; this module only supplies the descriptor and the read-time
 * projection. The two axes — schedule (week→OS) and content (domaine→chapter→OS)
 * — are read through the edges (childrenOf), never a denormalized number.
 */
import { listEntries } from "../storage/index.js";
import { neighborhoodDomains, suggestFreshDomain, domainUsage } from "../generation/index.js";
import { parseGraph, terminologySections, emptyContainerWarnings, type GraphParseDescriptor } from "../curriculum/index.js";
import { noAccents } from "../utils/index.js";
import { makeEnsure, detectEnvelope, aggregateCharacters, alignedStandardOf, textWording } from "./engine.js";
import type {
  SubjectAdapter, DeliverableSpec,
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
// An illustrative task (Activity) aligns to a STANDARD via hasEducationalAlignment;
// the specific component it exemplifies is carried here (canonical: no Activity↔LC edge).
type Illustrates = { id?: string; name?: string; order?: number };
const illustrates = (u: CurriculumUnit): Illustrates => ((u.properties.metadata as { illustratesComponent?: Illustrates })?.illustratesComponent) ?? {};

// ── Raw envelope → CurriculumModel ──────────────────────────────────────────
// Delegated to the generic parser; the descriptor is all that is subject-specific.
// The bilan (end-of-chapter assessment) is the one raw quirk that needs a hook:
// per chapter, the last lesson whose text mentions "bilan", else the last lesson.
// After the graph-native-authoring split (docs/design-notes/graph-native-authoring.md):
//   - a `chapter` is a content LessonGrouping (label-keyed), not a spine subtopic;
//   - a `lesson` is a content Lesson node (label-keyed) that `supports` its
//     `expectation` — the spine standard (objectif spécifique), now its own kind,
//     which still carries the OS text and the components/tasks beneath it.
// So the read of a lesson gathers leconNum/week from the Lesson node and
// osTexte/components/statementType from the aligned expectation (see buildSlice).
const MATHS_PARSE: GraphParseDescriptor = {
  roleToKind: {
    week: "week",
    strand: "domaine",
    expectation: "expectation",
    "intégration du palier": "expectation",
  },
  // Canonical LC labels: the RECE illustrative tasks are `Activity` (was the
  // `Curriculum` catch-all). Both authored chapters and RECE task-groupings are
  // `LessonGrouping` — the adapter's `chaptersIn` filters to authored chapters
  // (statementType "Chapitre"); the task-groupings stay out of the chapter view.
  labelToKind: { Lesson: "lesson", LessonGrouping: "chapter", LearningComponent: "component", Activity: "task" },
  numberFrom: "order",
  // Chapter progression is the canonical content prerequisite `hasDependency`
  // (`dependent hasDependency prereq`), read reversed into buildsTowards/buildsFrom.
  dependencyEdge: "hasDependency",
  // The bilan (end-of-chapter assessment) needs no hook: parseGraph reads it from
  // canonical LC educationalUse === "Assessment" onto isAssessment for every subject.
};

function parse(raw: unknown): CurriculumModel {
  return parseGraph(raw, MATHS_PARSE);
}

// ── Coverage / consistency warnings (#13) ────────────────────────────────────
// Simplified by the convergence: chapter→lesson is now a real `hasChild` edge, so
// the whole chapitreNum-drift machinery is gone. Two rules remain: a chapter with
// no lessons (generic), and a chapter with 0 or >1 bilan. NOTE: multiParentWarnings
// is deliberately NOT applied to lessons — a lesson legitimately has TWO parents
// now (its week on the schedule axis, its chapter on the content axis).
const CONTENT_CONTAINMENT = "hasPart"; // canonical LC: chapter→lesson is content containment
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
    if (e.type !== CONTENT_CONTAINMENT) continue;
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
  const ensure = makeEnsure(parse);

  // Read helpers, all parametrized by the CurriculumModel they read (published via
  // ensure(); a draft-resolved model for preview). Chapter→lesson and week→lesson
  // are followed through the EDGES (childrenOf), not any number.
  // Authored chapters only. Canonically the RECE task-groupings are also
  // `LessonGrouping` (kind "chapter"), so filter to the ones stamped statementType
  // "Chapitre" — task-groupings (contentType "Regroupement de tâches") stay out of
  // the chapter projection, keeping listUnits/slice byte-identical.
  const chaptersIn = (m: CurriculumModel) => m.unitsOfKind("chapter").filter((c) => c.properties.statementType === "Chapitre");
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
    const expOf = alignedStandardOf(m); // lesson → the spine standard it aligns to
    // Illustrative tasks align to a STANDARD; the component each exemplifies rides
    // in metadata.illustratesComponent. Index tasks by that component id (ordered),
    // replacing the old (non-canonical) activity→component edge.
    const tasksByComponent = new Map<string, CurriculumUnit[]>();
    for (const t of m.unitsOfKind("task")) {
      const cid = illustrates(t).id;
      if (cid) (tasksByComponent.get(cid) ?? tasksByComponent.set(cid, []).get(cid)!).push(t);
    }
    for (const list of tasksByComponent.values()) list.sort((a, b) => (illustrates(a).order ?? 0) - (illustrates(b).order ?? 0));
    // The lesson's stable identifier is its aligned expectation's id (the OS): the
    // Lesson node is an authoring wrapper, but downstream references key on the OS.
    const identityOf = (ln: CurriculumUnit) => expOf.get(ln.id)?.id ?? ln.id;
    const bilanId = (() => {
      const b = lessonUnits.find((l) => l.isAssessment);
      return b ? identityOf(b) : null;
    })();

    const lessons = lessonUnits.map((ln) => {
      // Teaching facts (number, week) come from the Lesson; standard facts (OS
      // text, components/tasks, statement type/code, palier) from the expectation.
      const ex = expOf.get(ln.id) ?? ln;
      const components = m.childrenOf(ex.id).filter((c) => c.kind === "component").map((cn) => ({
        identifier: cn.id,
        description: cn.text ?? null,
        description_en: meta(cn).en?.description ?? null,
        reference: rawStr(cn, "reference"),
        tasks: (tasksByComponent.get(cn.id) ?? []).map((tn) => ({
          identifier: tn.id,
          description: tn.text ?? null,
          contentType: rawStr(tn, "contentType"),
        })),
      }));
      return {
        identifier: identityOf(ln), leconNum: ln.order ?? null, osTexte: ex.text ?? null,
        statementType: meta(ex).role ?? null, statementCode: rawStr(ex, "statementCode"),
        semaine: weekOf.get(ln.id) ?? null, palier: (ex.properties.palier as number) ?? null,
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
    // Post-split, wording lives on two kinds: the OS text is on the `expectation`
    // (the spine standard); the content `lesson` carries only its own title. A
    // Lesson node has no `raw.os_texte` mirror, so its alias must not list one
    // (the upsert existing-key rule would block the edit).
    wordingAliases: {
      // lesson/component/task carry standard text/text_en; chapter keeps its name
      // in `title`, and the expectation (OS) mirrors a second raw path (raw.osTexte).
      ...textWording("lesson", "component", "task"),
      chapter: {
        title:    ["title", "raw.description"],
        title_en: ["raw.metadata.en.description"],
      },
      expectation: {
        text:    ["text", "raw.description", "raw.osTexte"],
        text_en: ["raw.metadata.en.description", "raw.metadata.en.os_texte"],
      },
    },

    // The curriculum recipes are now generic, graph-derived verbs (kg-recipes);
    // this adapter no longer declares a recipeProfile / structuralAliases /
    // lcNodeTemplate. add_node reads a created chapter's/lesson's LC identity
    // (labels, "Chapitre" statement type, role, ordinal path raw.metadata.order)
    // by copying an existing chapter/lesson in the graph.
    coverageWarnings: ciMathsCoverageWarnings,

    detect: detectEnvelope, parse,

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
      const establishedCharacters = aggregateCharacters(entries);

      const coverage = listUnitsIn(m).map((c) => ({
        chapter: c.chapitreNum,
        hasManual: entries.some((e) => e.unit === c.chapitreNum && e.type === "manual"),
        hasLessons: entries.some((e) => e.unit === c.chapitreNum && e.type === "lessons"),
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
