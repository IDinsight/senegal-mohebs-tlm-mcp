import { readFileSync } from "node:fs";
import { CONFIG, kgSource } from "../../config.js";
import { sourcePath, sessionState } from "../../context/index.js";
import { buildModel, unit } from "../model.js";
import { PRELOADED_MODEL_KEY } from "../store-bridge.js";
import type { CurriculumAdapter, CurriculumModel, CurriculumUnit, SubjectCurriculum } from "../../types.js";

// Raw CE1-reading graph shape: two arrays (`nodes` + `relationships`), a `hasChild`
// edge-tree for hierarchy, and `supports` edges hanging learning components off
// the standards. Endpoints are keyed differently per edge type (see below). This
// module is the ONLY place that knows any of it.
type RawNode = { id: string; labels?: string[]; properties?: Record<string, any> };
type RawRel = { id: string; type: string; start: string; end: string; properties?: Record<string, any> };
type RawGraph = { nodes: RawNode[]; relationships: RawRel[] };

const prop = (n: RawNode | undefined, k: string) => n?.properties?.[k];
// A node's role: the curriculum statement_type when present, else its graph label.
const nodeType = (n: RawNode) => String(prop(n, "statement_type") ?? n.labels?.[0] ?? "");
// The six language-tool strands the KG scopes per week (the "outils de langue").
const STRAND_TYPES = new Set(["Conjugaison", "Vocabulaire", "Orthographe", "Grammaire", "Écriture / Copie", "Production d'écrits"]);
// Genre targets per palier, taken from the curriculum's own "jéego" wording.
const GENRE_BY_PALIER: Record<number, string> = {
  1: "narratif",
  2: "narratif, descriptif",
  3: "narratif, descriptif, injonctif",
};

// ── Adapter: envelope + taxonomy + hierarchy → normalized model ──────────────
export const readingAdapter: CurriculumAdapter = {
  id: "ce1-reading/nodes-relationships-v1",

  // Cheap structural guard: nodes + relationships arrays with at least one
  // hasChild edge and a numeric-week "Standard Grouping". Deliberately disjoint
  // from the maths guard, which looks for a top-level `graph` array.
  detect(raw: unknown): boolean {
    const g = raw as Partial<RawGraph> | undefined;
    if (!Array.isArray(g?.nodes) || !Array.isArray(g?.relationships)) return false;
    const hasTree = g!.relationships.some((r) => r?.type === "hasChild");
    const hasWeek = g!.nodes.some((n) => prop(n, "normalized_statement_type") === "Standard Grouping" && /^\d+$/.test(String(prop(n, "description") ?? "")));
    return hasTree && hasWeek;
  },

  parse(raw: unknown): CurriculumModel {
    const g = raw as RawGraph;
    const nodes = g.nodes ?? [];
    const rels = g.relationships ?? [];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    // hasChild endpoints are node ids on both ends → straightforward parent/child.
    const parentOf = new Map<string, string>();
    for (const r of rels) if (r.type === "hasChild") parentOf.set(r.end, r.start);
    const isType = (id: string | undefined, t: string) => id != null && nodeType(nodeById.get(id)!) === t;
    // Walk up to the enclosing "Palier N …" substage and read its number. The
    // label sits in the substage's `description` (e.g. "Palier 2 - Communication
    // écrite"); fall back to title/statement_label if a future export moves it.
    const palierOf = (startId: string): number | null => {
      for (let id: string | undefined = startId; id; id = parentOf.get(id)) {
        if (isType(id, "substage")) {
          const s = prop(nodeById.get(id)!, "description") ?? prop(nodeById.get(id)!, "title") ?? prop(nodeById.get(id)!, "statement_label") ?? "";
          const m = /palier\s*(\d)/i.exec(String(s));
          if (m) return Number(m[1]);
        }
      }
      return null;
    };

    // Week groupings: "Standard Grouping" nodes whose description is the week
    // number. The KG duplicates palier-2/3 weeks — one grouping is populated, its
    // twin is an empty skeleton — so per week we keep the grouping with the most
    // populated strand children (most non-empty descriptions).
    const groupings = nodes.filter((n) => prop(n, "normalized_statement_type") === "Standard Grouping" && /^\d+$/.test(String(prop(n, "description") ?? "")));
    const childIdsOf = (id: string) => rels.filter((r) => r.type === "hasChild" && r.start === id).map((r) => r.end);
    const populatedStrands = (groupId: string) =>
      childIdsOf(groupId).filter((cid) => STRAND_TYPES.has(nodeType(nodeById.get(cid)!)) && String(prop(nodeById.get(cid)!, "description") ?? "").trim() !== "").length;
    const bestByWeek = new Map<number, RawNode>();
    for (const grp of groupings) {
      const wk = Number(prop(grp, "description"));
      const cur = bestByWeek.get(wk);
      if (!cur || populatedStrands(grp.id) > populatedStrands(cur.id)) bestByWeek.set(wk, grp);
    }

    const units: CurriculumUnit[] = [];
    const standardByCaseUuid = new Map<string, CurriculumUnit>(); // for `supports` resolution

    // Weeks (roots) and their strand standards. File order within a week follows
    // the KG; presenters sort strands into the canonical order themselves.
    for (const [wk, grp] of [...bestByWeek.entries()].sort((a, b) => a[0] - b[0])) {
      const palier = palierOf(grp.id);
      const weekUnit = unit({
        id: grp.id, kind: "week", title: String(wk), order: wk,
        properties: { semaine: wk, palier, genre: palier ? GENRE_BY_PALIER[palier] ?? null : null },
      });
      units.push(weekUnit);

      for (const cid of childIdsOf(grp.id)) {
        const cn = nodeById.get(cid)!;
        const strand = nodeType(cn);
        if (!STRAND_TYPES.has(strand)) continue;
        const std = unit({
          id: cn.id, kind: "standard", code: strand, text: (prop(cn, "description") as string) ?? null,
          parentId: weekUnit.id,
          properties: { strand, statementCode: prop(cn, "statement_code") ?? null, caseUuid: prop(cn, "case_identifier_uuid") ?? null },
        });
        weekUnit.childIds.push(std.id);
        units.push(std);
        const caseUuid = prop(cn, "case_identifier_uuid");
        if (caseUuid) standardByCaseUuid.set(String(caseUuid), std);
      }
    }

    // Learning components, attached to their standard via `supports` edges. Here
    // the endpoints are keyed DIFFERENTLY: start = the component's identifier,
    // end = the standard's case_identifier_uuid (not a node id). Index components
    // by both id and properties.identifier so the start key resolves either way.
    const componentByKey = new Map<string, CurriculumUnit>();
    for (const n of nodes) {
      if (n.labels?.[0] !== "LearningComponent") continue;
      const comp = unit({ id: n.id, kind: "component", text: (prop(n, "description") as string) ?? null, properties: n.properties ?? {} });
      units.push(comp);
      componentByKey.set(n.id, comp);
      const ident = prop(n, "identifier");
      if (ident) componentByKey.set(String(ident), comp);
    }
    for (const r of rels) {
      if (r.type !== "supports") continue;
      const comp = componentByKey.get(r.start);
      const std = standardByCaseUuid.get(r.end);
      if (comp && std) { comp.parentId = std.id; std.childIds.push(comp.id); }
    }

    return buildModel(units);
  },
};

// ── SubjectCurriculum: lazily load the reading KG, parse to a model, and render
// the reading-shaped tool JSON. A "unit" here is a WEEK (semaine); its slice is
// the week's six language-tool standards with their learning components, plus the
// palier, genre, and cross-week progression derived from week ordering (the KG
// carries no progression edges). ────────────────────────────────────────────
export function createReadingCurriculum(): SubjectCurriculum {
  // Closure cache is safe without a reset hook: activateContext() builds a fresh
  // profile (and thus a fresh curriculum + empty cache) on every context switch.
  let model: CurriculumModel | null = null;
  const ensure = (): CurriculumModel => {
    if (model) return model;
    if (kgSource() === "firestore") {
      const preloaded = sessionState().bag.get(PRELOADED_MODEL_KEY) as CurriculumModel | undefined;
      if (!preloaded) throw new Error("KG_SOURCE=firestore but curriculum was not preloaded from the store. Call activateContext() first.");
      return (model = preloaded);
    }
    return (model = readingAdapter.parse(JSON.parse(readFileSync(sourcePath(CONFIG.kgFile), "utf8"))));
  };

  const weeks = () => ensure().unitsOfKind("week").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const weekOf = (wk: number) => weeks().find((w) => w.properties.semaine === wk) ?? null;
  const STRAND_ORDER = ["Vocabulaire", "Grammaire", "Orthographe", "Conjugaison", "Production d'écrits", "Écriture / Copie"];

  const buildSlice = (wk: number) => {
    const m = ensure();
    const week = weekOf(wk);
    if (!week) return null;
    const standards = m.childrenOf(week.id)
      .filter((c) => c.kind === "standard")
      .sort((a, b) => STRAND_ORDER.indexOf(a.code ?? "") - STRAND_ORDER.indexOf(b.code ?? ""))
      .map((std) => ({
        strand: std.code,
        osTexte: std.text,
        statementCode: (std.properties.statementCode as string) ?? null,
        components: m.childrenOf(std.id).filter((c) => c.kind === "component").map((c) => ({ identifier: c.id, description: c.text })),
      }));
    return {
      semaine: wk,
      palier: (week.properties.palier as number) ?? null,
      genre: (week.properties.genre as string) ?? null,
      languageToolStandards: standards,
    };
  };

  // Progression by week ordering across the weeks the KG actually carries (it
  // skips integration/evaluation weeks, so neighbours may not be wk±1).
  const buildProgression = (wk: number) => {
    const nums = weeks().map((w) => w.properties.semaine as number);
    const i = nums.indexOf(wk);
    return {
      buildsFrom: i > 0 ? [nums[i - 1]] : [],
      buildsTowards: i >= 0 && i < nums.length - 1 ? [nums[i + 1]] : [],
    };
  };

  return {
    adapter: readingAdapter,
    detect: (raw) => readingAdapter.detect(raw),
    listUnits: () =>
      weeks().map((w) => ({ semaine: w.properties.semaine, palier: w.properties.palier ?? null, genre: w.properties.genre ?? null })),
    slice: (scope) => buildSlice(Number(scope)),
    progression: (scope) => buildProgression(Number(scope)),
    requiredCoverage: (scope) => {
      const s = buildSlice(Number(scope));
      return s ? s.languageToolStandards.map((st) => ({ strand: st.strand, osTexte: st.osTexte })) : [];
    },
    scopeValues: () => weeks().map((w) => w.properties.semaine as number),
  };
}
