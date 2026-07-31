// ── Module: adapters · CI maths ───────────────────────────────────────────────
// The single per-subject adapter module for CI maths. Consolidates what used
// to live in three files — the raw-graph parser (curriculum/adapters/maths.ts),
// the LC→friendly presenter (createMathsCurriculum), and the subject profile
// (profiles/maths.ts) — into one place. Behavior only: no schema, no LC
// property/edge/cardinality declarations, no integrity rules. Storage
// round-trip lives in curriculum/store-bridge.ts and runs on the parsed
// CurriculumModel (subject-agnostic) — the adapter doesn't know about the
// store shape.
import { readFileSync } from "node:fs";
import { CONFIG, kgSource } from "../config.js";
import { sourcePath, sessionState } from "../context/index.js";
import { listEntries } from "../storage/index.js";
import { neighborhoodDomains, suggestFreshDomain, domainUsage } from "../generation/index.js";
import { buildModel, unit, terminologySections, PRELOADED_MODEL_KEY, emptyContainerWarnings, multiParentWarnings } from "../curriculum/index.js";
import { noAccents } from "../utils/index.js";
import type {
  SubjectAdapter, DeliverableSpec, CharacterRef,
  CurriculumModel, CurriculumUnit, GraphView,
} from "../types.js";

// Raw CI-maths graph shape: a single `graph` array of discriminated nodes and
// relationships. This module is the ONLY place that knows it.
type RawNode = { type: "node"; identifier: string; labels: string[]; properties: Record<string, any> };
type RawRel = { type: "relationship"; identifier: string; label: string; source_identifier: string; target_identifier: string };
type RawGraph = { graph: (RawNode | RawRel)[] };

const isNode = (e: any): e is RawNode => e?.type === "node";
const isRel = (e: any): e is RawRel => e?.type === "relationship";

const ADAPTER_ID = "ci-maths/graph-array-v1";

// Teacher guide filenames contain "fiche(s) de leçon"; everything else is the
// pupil manual. The two rules are mutually exclusive, so discovery matches
// exactly one deliverable per file.
const isLessons = (filename: string) => noAccents(filename).includes("fiches de lecons") || noAccents(filename).includes("fiche de lecon");

const DELIVERABLES: DeliverableSpec[] = [
  { key: "manual", label: "Manuel de l'élève (pupil book)", scopeKind: "chapter", classify: (f) => !isLessons(f), dependsOn: [], promptFile: "PROMPT_generate_chapter.md" },
  { key: "lessons", label: "Fiches de leçons (teacher guide)", scopeKind: "chapter", classify: isLessons, dependsOn: ["manual"], promptFile: "PROMPT_generate_lessons.md" },
];

// ── Raw envelope → CurriculumModel ──────────────────────────────────────────
// Kept as module-level pure functions (no closure state) so they can be
// referenced from the built adapter object without allocation per activation.

function detect(raw: unknown): boolean {
  const g = (raw as RawGraph | undefined)?.graph;
  return Array.isArray(g) && g.some((e) => isNode(e) && e.properties?.statementType === "Chapitre");
}

function parse(raw: unknown): CurriculumModel {
  const graph = (raw as RawGraph).graph ?? [];
  const nodes = graph.filter(isNode);
  const rels = graph.filter(isRel);
  const nodeById = new Map(nodes.map((n) => [n.identifier, n]));
  const label0 = (id: string) => nodeById.get(id)?.labels?.[0];

  const units: CurriculumUnit[] = [];

  // Chapters and lessons (both StandardsFrameworkItem, told apart by statementType).
  const chapterNodes = nodes.filter((n) => n.labels[0] === "StandardsFrameworkItem" && n.properties.statementType === "Chapitre");
  const lessonNodes = nodes.filter((n) => n.labels[0] === "StandardsFrameworkItem" && String(n.properties.statementType ?? "").startsWith("OS") && n.properties.leconNum != null);
  const componentNodes = nodes.filter((n) => n.labels[0] === "LearningComponent");
  const taskNodes = nodes.filter((n) => n.labels[0] === "Curriculum");

  for (const n of chapterNodes)
    units.push(unit({ id: n.identifier, kind: "chapter", title: n.properties.chapitreTitre ?? null, order: n.properties.chapitreNum ?? null, properties: n.properties }));
  for (const n of lessonNodes)
    units.push(unit({ id: n.identifier, kind: "lesson", code: n.properties.statementCode ?? null, text: n.properties.osTexte ?? null, order: n.properties.leconNum ?? null, properties: n.properties }));
  for (const n of componentNodes)
    units.push(unit({ id: n.identifier, kind: "component", text: n.properties.description ?? null, properties: n.properties }));
  for (const n of taskNodes)
    units.push(unit({ id: n.identifier, kind: "task", text: n.properties.description ?? null, properties: n.properties }));

  const byId = new Map(units.map((u) => [u.id, u]));

  // Chapter→lesson: shared property (chapitreNum), NOT an edge. Match the maths schema.
  const chaptersByNum = new Map<number, CurriculumUnit>();
  for (const c of units) if (c.kind === "chapter") chaptersByNum.set(c.properties.chapitreNum as number, c);
  for (const l of units) {
    if (l.kind !== "lesson") continue;
    const parent = chaptersByNum.get(l.properties.chapitreNum as number);
    if (parent) { l.parentId = parent.id; parent.childIds.push(l.id); }
  }

  // Lesson→component and component→task: `supports` edges (source=child, target=parent).
  // Iterate rels in file order so child ordering matches the historical output.
  for (const r of rels) {
    if (r.label !== "supports") continue;
    const child = byId.get(r.source_identifier);
    const parent = byId.get(r.target_identifier);
    if (!child || !parent) continue;
    if (parent.kind === "lesson" && label0(r.source_identifier) === "LearningComponent") { child.parentId = parent.id; parent.childIds.push(child.id); }
    else if (parent.kind === "component" && label0(r.source_identifier) === "Curriculum") { child.parentId = parent.id; parent.childIds.push(child.id); }
  }

  // Cross-chapter progression: `buildsTowards` edges between chapter nodes.
  for (const r of rels) {
    if (r.label !== "buildsTowards") continue;
    const from = byId.get(r.source_identifier);
    const to = byId.get(r.target_identifier);
    if (from?.kind === "chapter" && to?.kind === "chapter") { from.buildsTowards.push(to.id); to.buildsFrom.push(from.id); }
  }

  // Assessment (bilan): last lesson matching /bilan/i on its text, else the last lesson.
  for (const c of units) {
    if (c.kind !== "chapter") continue;
    const lessons = c.childIds.map((id) => byId.get(id)!).filter((u) => u.kind === "lesson").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const bilan = [...lessons].reverse().find((l) => /bilan/i.test(String(l.text ?? ""))) ?? lessons[lessons.length - 1];
    if (bilan) bilan.isAssessment = true;
  }

  return buildModel(units);
}

// ── Coverage / consistency warnings (#13) ────────────────────────────────────
// Unit-shaped completeness checks for CI maths. All WARNINGS — they inform the
// reviewer, never block. Two generic shapes (empty chapter, lesson with >1
// parent) come from the shared helpers; two are maths-specific and live here
// because only this adapter knows what a "bilan" is and that maths denormalizes
// the chapter→lesson link into `raw.chapitreNum`.
//
// Operates on the raw store graph. Maths store nodes carry `isAssessment` at
// `properties.isAssessment` and the chapter number at `properties.raw.chapitreNum`.
//
// The chapter→lesson relationship used here is the `hasChild` EDGE — the id-based
// referential backbone that Rule 2 guards. `chapitreNum` is a denormalized copy
// the presenter happens to read; the drift rule below is exactly the check that
// the copy still agrees with the backbone. On seed data all four rules are
// silent (verified): every chapter has lessons, exactly one bilan, and matching
// numbers.
const HAS_CHILD = "hasChild";
const rawChapitreNum = (n: GraphView["nodes"][number]): number | null => {
  const raw = n.properties.raw as Record<string, unknown> | undefined;
  const v = raw?.chapitreNum;
  return typeof v === "number" ? v : null;
};

function mathsCoverageWarnings(graph: GraphView): string[] {
  const warnings: string[] = [];

  // (1) + (2) Generic tree shapes, keyed by maths kind names.
  warnings.push(...emptyContainerWarnings(graph, ["chapter"]));
  warnings.push(...multiParentWarnings(graph, ["lesson"]));

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const chapters = graph.nodes.filter((n) => n.type === "chapter");
  const lessons = graph.nodes.filter((n) => n.type === "lesson");

  // Edge-children lessons per chapter (the referential backbone).
  const childLessonsByChapter = new Map<string, GraphView["nodes"]>();
  for (const e of graph.edges) {
    if (e.type !== HAS_CHILD) continue;
    const to = byId.get(e.to);
    if (!byId.get(e.from) || byId.get(e.from)!.type !== "chapter") continue;
    if (!to || to.type !== "lesson") continue;
    (childLessonsByChapter.get(e.from) ?? childLessonsByChapter.set(e.from, []).get(e.from)!).push(to);
  }

  // (3) Bilan: a chapter WITH lessons is expected to have exactly one bilan
  // (isAssessment) lesson. Empty chapters are already flagged by (1), so we
  // only speak to chapters that have lessons — 0 or >1 bilan is the finding.
  for (const c of chapters) {
    const childLessons = childLessonsByChapter.get(c.id) ?? [];
    if (childLessons.length === 0) continue; // covered by emptyContainerWarnings
    const bilans = childLessons.filter((l) => l.properties.isAssessment === true).length;
    const label = (c.properties.title as string) ?? c.id;
    if (bilans === 0)
      warnings.push(`Coverage: chapter '${label}' has ${childLessons.length} lesson(s) but no bilan (end-of-chapter assessment). Mark one lesson as the bilan before publishing.`);
    else if (bilans > 1)
      warnings.push(`Coverage: chapter '${label}' has ${bilans} bilan lessons — exactly one is expected.`);
  }

  // (4) chapitreNum drift — the regime-B consistency check. The maths presenter
  // joins lessons to chapters by `raw.chapitreNum`, not by the hasChild edge, so
  // if the number disagrees with the edge-parent the lesson silently fails to
  // render under its chapter. WARN (not block): the edge backbone is intact and
  // Rule-2-guarded; this is a presentation inconsistency the reviewer should see.
  const chapterNums = new Set(chapters.map(rawChapitreNum).filter((n): n is number => n != null));
  for (const c of chapters) {
    const cn = rawChapitreNum(c);
    for (const l of childLessonsByChapter.get(c.id) ?? []) {
      const ln = rawChapitreNum(l);
      if (cn != null && ln != null && cn !== ln) {
        const label = (l.properties.text as string) ?? l.id;
        warnings.push(`Coverage: lesson '${label}' is linked to chapter number ${cn} but its own chapitreNum is ${ln} — the maths view joins on chapitreNum, so this lesson will not render under its chapter. Align the numbers.`);
      }
    }
  }
  // A lesson whose chapitreNum points at no existing chapter number at all.
  for (const l of lessons) {
    const ln = rawChapitreNum(l);
    if (ln != null && !chapterNums.has(ln)) {
      const label = (l.properties.text as string) ?? l.id;
      warnings.push(`Coverage: lesson '${label}' has chapitreNum ${ln}, but no chapter has that number — it will not render anywhere in the maths view.`);
    }
  }

  return warnings;
}

// ── Factory: build the (grade, subject)-bound adapter ────────────────────────
// Closure cache for the parsed model is safe without a reset hook: activateContext
// builds a fresh adapter (and thus a fresh empty cache) on every context switch.
export function buildMathsAdapter(grade: string, subject: string): SubjectAdapter {
  let model: CurriculumModel | null = null;
  const ensure = (): CurriculumModel => {
    if (model) return model;
    // KG_SOURCE=firestore: activate.ts hydrates the model asynchronously and
    // stashes it in the session bag before returning. Anything reaching this
    // adapter without a preloaded model is a wiring bug — reads must not fall
    // through to a bundle in Firestore mode.
    if (kgSource() === "firestore") {
      const preloaded = sessionState().bag.get(PRELOADED_MODEL_KEY) as CurriculumModel | undefined;
      if (!preloaded) throw new Error("KG_SOURCE=firestore but curriculum was not preloaded from the store. Call activateContext() first.");
      return (model = preloaded);
    }
    return (model = parse(JSON.parse(readFileSync(sourcePath(CONFIG.kgFile), "utf8"))));
  };

  const chapters = () => ensure().unitsOfKind("chapter");
  const lessonsOf = (m: CurriculumModel, chapNum: number) =>
    m.unitsOfKind("lesson").filter((l) => l.properties.chapitreNum === chapNum).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const chapterOf = (chapNum: number) => chapters().find((c) => c.properties.chapitreNum === chapNum) ?? null;

  const buildSlice = (chapNum: number) => {
    const m = ensure();
    const chapterUnit = chapterOf(chapNum);
    const lessonUnits = lessonsOf(m, chapNum);
    if (lessonUnits.length === 0 && !chapterUnit) return null;
    const bilanId = lessonUnits.find((l) => l.isAssessment)?.id ?? null;

    const lessons = lessonUnits.map((ln) => {
      const components = m.childrenOf(ln.id).filter((c) => c.kind === "component").map((cn) => ({
        identifier: cn.id,
        description: (cn.properties.description as string) ?? null,
        description_en: (cn.properties.description_en as string) ?? null,
        reference: (cn.properties.reference as string) ?? null,
        tasks: m.childrenOf(cn.id).filter((t) => t.kind === "task").map((tn) => ({
          identifier: tn.id,
          description: (tn.properties.description as string) ?? null,
          contentType: (tn.properties.contentType as string) ?? null,
        })),
      }));
      return {
        identifier: ln.id, leconNum: ln.properties.leconNum ?? null, osTexte: ln.properties.osTexte ?? null,
        statementType: ln.properties.statementType ?? null, statementCode: ln.properties.statementCode ?? null,
        semaine: ln.properties.semaine ?? null, palier: ln.properties.palier ?? null,
        isBilan: ln.isAssessment, components,
      };
    });
    return {
      chapitreNum: chapNum,
      chapitreTitre: (chapterUnit?.properties.chapitreTitre as string) ?? (lessonUnits[0]?.properties.chapitreTitre as string) ?? null,
      domaine: (chapterUnit?.properties.domaine as string) ?? (lessonUnits[0]?.properties.domaine as string) ?? null,
      lessons, bilanLessonId: bilanId,
    };
  };

  const buildProgression = (chapNum: number) => {
    const m = ensure();
    const chapterUnit = chapterOf(chapNum);
    if (!chapterUnit) return { buildsTowards: [] as number[], buildsFrom: [] as number[] };
    const numOf = (id: string) => m.byId.get(id)?.properties.chapitreNum as number | undefined;
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
    // Wording paths a curator may edit via upsert_property (#10). Each
    // logical key maps to the storage paths its wording is stored under.
    // Chapter's title lives in BOTH the normalized field (what presenters
    // read) AND the raw source (what preserves the source graph faithfully)
    // — declaring both here means one curator call keeps them in sync
    // without the curator having to know the storage layout.
    wordingAliases: {
      chapter: {
        title:    ["title", "raw.chapitreTitre"],
        title_en: ["raw.chapitreTitre_en"],
      },
      lesson: {
        text:    ["text", "raw.osTexte"],
        text_en: ["raw.osTexte_en"],
      },
      component: {
        text:    ["text", "raw.description"],
        text_en: ["raw.description_en"],
      },
      task: {
        text:    ["text", "raw.description"],
        text_en: ["raw.description_en"],
      },
    },

    // Coverage / consistency warnings (#13) — unit-shaped completeness checks.
    // A module-level pure function so it needs no closure state; see its
    // definition above for the four rules (empty chapter, missing/>1 bilan,
    // lesson with >1 parent, chapitreNum drift).
    coverageWarnings: mathsCoverageWarnings,

    detect, parse,

    listUnits: () =>
      chapters()
        .map((c) => ({ chapitreNum: c.properties.chapitreNum, chapitreTitre: c.properties.chapitreTitre ?? null, domaine: c.properties.domaine ?? null }))
        .sort((a, b) => (a.chapitreNum as number) - (b.chapitreNum as number)),
    slice: (scope) => buildSlice(Number(scope)),
    progression: (scope) => buildProgression(Number(scope)),
    requiredCoverage: (scope) => {
      const s = buildSlice(Number(scope));
      return s ? s.lessons.filter((l) => !l.isBilan).map((l) => ({ leconNum: l.leconNum, osTexte: l.osTexte })) : [];
    },
    scopeValues: () => chapters().map((c) => c.properties.chapitreNum as number).sort((a, b) => a - b),

    // Reproduces the historical getGenerationContext output verbatim.
    async buildGenerationContext(scope, deliverableKey) {
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
          if (!existing) {
            charMap.set(c.name, { name: c.name, type: c.type, role: c.role, description: c.description, firstChapter: e.chapter });
          } else {
            existing.firstChapter = Math.min(existing.firstChapter, e.chapter);
            existing.type ??= c.type;
            existing.role ??= c.role;
            existing.description ??= c.description;
          }
        }
      }
      const establishedCharacters = [...charMap.values()].sort((a, b) => a.firstChapter - b.firstChapter || a.name.localeCompare(b.name));

      const coverage = (this.listUnits() as Array<{ chapitreNum: number }>).map((c) => ({
        chapter: c.chapitreNum,
        hasManual: entries.some((e) => e.chapter === c.chapitreNum && e.type === "manual"),
        hasLessons: entries.some((e) => e.chapter === c.chapitreNum && e.type === "lessons"),
      }));

      const manualForThisChapter = entries.find((e) => e.id === `${chapter}:manual`) ?? null;
      if (docType === "lessons" && !manualForThisChapter) notes.push(`No pupil manual is tracked for chapter ${chapter}. Lesson sheets build on the manual — generate or ingest the manual first.`);

      const curriculumSlice = this.slice(chapter);
      if (!curriculumSlice) notes.push(`Chapter ${chapter} was not found in the knowledge graph.`);

      return {
        unit: chapter, deliverable: docType, curriculum: curriculumSlice, progression: this.progression(chapter), requiredLessonCoverage: this.requiredCoverage(chapter),
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

    // Maths-only capability: exampleDomainRotation. Gated at the tool boundary
    // in src/server/maths.ts via capabilities.exampleDomainRotation.
    suggestFreshDomain: () => suggestFreshDomain(),
    domainUsage: () => domainUsage(),
  };
}
