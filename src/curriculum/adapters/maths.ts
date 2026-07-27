import { readFileSync } from "node:fs";
import { CONFIG } from "../../config.js";
import { sourcePath } from "../../context/index.js";
import { buildModel, unit } from "../model.js";
import type { CurriculumAdapter, CurriculumModel, CurriculumUnit, SubjectCurriculum } from "../../types.js";

// Raw CI-maths graph shape: a single `graph` array of discriminated nodes and
// relationships. This module is the ONLY place that knows it.
type RawNode = { type: "node"; identifier: string; labels: string[]; properties: Record<string, any> };
type RawRel = { type: "relationship"; identifier: string; label: string; source_identifier: string; target_identifier: string };
type RawGraph = { graph: (RawNode | RawRel)[] };

const isNode = (e: any): e is RawNode => e?.type === "node";
const isRel = (e: any): e is RawRel => e?.type === "relationship";

// ── Adapter: envelope + taxonomy + hierarchy → normalized model ──────────────
export const mathsAdapter: CurriculumAdapter = {
  id: "ci-maths/graph-array-v1",

  // Cheap structural guard: a `graph` array containing at least one Chapitre node.
  detect(raw: unknown): boolean {
    const g = (raw as RawGraph | undefined)?.graph;
    return Array.isArray(g) && g.some((e) => isNode(e) && e.properties?.statementType === "Chapitre");
  },

  parse(raw: unknown): CurriculumModel {
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
  },
};

// ── SubjectCurriculum: lazily load the active subject's KG, parse to a model,
// and render the maths-shaped tool JSON from it. Output is byte-identical to the
// previous knowledge-graph.ts implementation (verified against a golden snapshot).
export function createMathsCurriculum(): SubjectCurriculum {
  // Closure cache is safe without a reset hook: activateContext() builds a fresh
  // profile (and thus a fresh curriculum + empty cache) on every context switch.
  let model: CurriculumModel | null = null;
  const ensure = (): CurriculumModel => (model ??= mathsAdapter.parse(JSON.parse(readFileSync(sourcePath(CONFIG.kgFile), "utf8"))));

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
    detect: (raw) => mathsAdapter.detect(raw),
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
  };
}
