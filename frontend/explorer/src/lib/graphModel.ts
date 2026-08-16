import type {
  DisplayGraph,
  DisplayNode,
  Lang,
  TaxonomyEntry,
  ViewSpec,
} from "../types";
import { pick } from "../i18n";

// A synthetic tree row (a grouping bucket or a node-type header) rather than a
// real graph node. Its metadata (bilingual label + which taxonomy level it groups
// by) lives in the model's `synthMeta` map, keyed by this id.
export type SynthMeta = {
  label: { fr: string; en: string };
  level?: string;
  value?: string;
  kindRoot?: boolean;
};

// A node exposed to the tree can be a real node id or a synthetic grouping id.
type OutEdge = { to: string; o: number; rel: string };

export const isSynth = (id: string): boolean =>
  id.startsWith("grp:") || id.startsWith("kind:");

// The graph model owns the per-graph indexes and the (lazily built, cached) view
// derivations. It mirrors the original single-file explorer's globals + functions,
// but as a self-contained object rebuilt once per loaded graph.
export type GraphModel = ReturnType<typeof createGraphModel>;

export function createGraphModel(data: DisplayGraph) {
  // id → node
  const N: Record<string, DisplayNode> = {};
  data.nodes.forEach((n) => (N[n.id] = n));

  // relation → from → sorted outgoing edges
  const outByRel: Record<string, Record<string, OutEdge[]>> = {};
  const inHasChild: Record<string, string> = {}; // child → hasChild parent
  const btOut: Record<string, string[]> = {}; // buildsTowards from → [to]
  const btIn: Record<string, string[]> = {}; // buildsTowards to → [from]

  // Adjacency keyed by the REAL LC edge type, both directions — the alignment tail
  // walks specific edge types (hasEducationalAlignment / supports) that the folded
  // `outByRel` traversal collapses onto "hasChild", so it needs the true type.
  const realOut: Record<string, Record<string, string[]>> = {}; // rel → s → [t]
  const realIn: Record<string, Record<string, string[]>> = {}; // rel → t → [s]

  data.edges.forEach((e) => {
    (outByRel[e.r] ||= {});
    (outByRel[e.r][e.s] ||= []).push({ to: e.t, o: e.o || 0, rel: e.rel || e.r });
    if (e.r === "hasChild") inHasChild[e.t] = e.s;
    if (e.r === "buildsTowards") {
      (btOut[e.s] ||= []).push(e.t);
      (btIn[e.t] ||= []).push(e.s);
    }
    const rel = e.rel || e.r;
    ((realOut[rel] ||= {})[e.s] ||= []).push(e.t);
    ((realIn[rel] ||= {})[e.t] ||= []).push(e.s);
  });
  for (const r in outByRel)
    for (const s in outByRel[r]) outByRel[r][s].sort((a, b) => a.o - b.o);

  // taxonomy: category key → entry (drives colour, legend, stats)
  const TAXO: Record<string, TaxonomyEntry> = {};
  (data.meta.taxonomy || []).forEach((x) => (TAXO[x.key] = x));

  const outTargets = (id: string, rel: string): string[] =>
    (outByRel[rel]?.[id] || []).map((x) => x.to);

  // Synthetic-row metadata, filled in as views are built.
  const synthByView: Record<string, SynthMeta> = {};
  const synthMeta = (id: string): SynthMeta | null => synthByView[id] || null;

  // Sort a pair of real node ids by ordinal, then by natural code order.
  const byNumThenCode = (a: string, b: string): number =>
    (N[a].ord ?? 0) - (N[b].ord ?? 0) ||
    String(N[a].code).localeCompare(String(N[b].code), undefined, {
      numeric: true,
    });

  // ── View builders (each memoised in `cache` by view id) ────────────────────
  type Built = { roots: string[]; childrenOf: Record<string, string[]> };
  const cache: Record<string, Built> = {};

  // Grouped spine: nested groups from `groupBy` props read off `anchorKind`
  // nodes, then the anchors, then the hasChild subtree (walked at read time).
  function buildGroupedSpine(spec: Extract<ViewSpec, { shape: "grouped-spine" }>): Built {
    if (cache[spec.id]) return cache[spec.id];
    const childrenOf: Record<string, string[]> = {};
    const anchors = data.nodes.filter((n) => n.kind === spec.params.anchorKind);
    const levels = spec.params.groupBy;
    const order = spec.params.order || null;

    const nest = (items: DisplayNode[], depth: number, prefix: string): string[] => {
      if (depth >= levels.length) {
        return items
          .slice()
          .sort(
            (a, b) =>
              (a.ord ?? 0) - (b.ord ?? 0) ||
              String(a.code).localeCompare(String(b.code), undefined, {
                numeric: true,
              }),
          )
          .map((n) => n.id);
      }
      const lvl = levels[depth];
      const buckets = new Map<string, DisplayNode[]>();
      items.forEach((n) => {
        const key = String((n as Record<string, unknown>)[lvl.key] ?? "");
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(n);
      });
      const keys = [...buckets.keys()];
      keys.sort((a, b) => {
        if (order) {
          const ia = order.indexOf(a);
          const ib = order.indexOf(b);
          if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
        }
        const na = Number(a);
        const nb = Number(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });
      const ids: string[] = [];
      keys.forEach((k) => {
        const sid = `grp:${spec.id}:${prefix}${k}`;
        const label = lvl.labelFr
          ? { fr: `${lvl.labelFr} ${k}`, en: `${lvl.labelEn || lvl.labelFr} ${k}` }
          : { fr: k || "—", en: k || "—" };
        synthByView[sid] = { label, level: lvl.key, value: k };
        childrenOf[sid] = nest(buckets.get(k)!, depth + 1, `${prefix}${k}/`);
        ids.push(sid);
      });
      return ids;
    };

    const roots = nest(anchors, 0, "");
    return (cache[spec.id] = { roots, childrenOf });
  }

  // Node-type view: a synthetic header per kind → its nodes → outgoing edges.
  function buildNodeType(): Built {
    if (cache.__nodetype) return cache.__nodetype;
    const byKind: Record<string, string[]> = {};
    data.nodes.forEach((n) => (byKind[n.kind] ||= []).push(n.id));
    const kinds = Object.keys(byKind).sort();
    const childrenOf: Record<string, string[]> = {};
    kinds.forEach((k) => {
      const sid = `kind:${k}`;
      synthByView[sid] = { label: { fr: k, en: k }, kindRoot: true };
      childrenOf[sid] = byKind[k].slice().sort(byNumThenCode);
    });
    return (cache.__nodetype = {
      roots: kinds.map((k) => `kind:${k}`),
      childrenOf,
    });
  }

  // Graft the spec's `alignmentTail` onto the built content tree. The tail is a set
  // of rules keyed by LC label: a node of label `from` gains its `rel` targets (in
  // direction `dir`) as extra children, and the same rules then apply to each
  // target — so the walk chains onward wherever a target matches another rule.
  // Curriculum uses it so a Lesson OR an Activity reveals the standard it teaches
  // (its alignment lives on whichever one the subject authored — teacher-guide
  // lessons vs. student-book activities), and each standard reveals its supporting
  // components. Every node is expanded once, so a standard reached from many
  // lessons/activities doesn't accumulate duplicate component children.
  function graftAlignmentTail(
    spec: Extract<ViewSpec, { shape: "label-tree" }>,
    childrenOf: Record<string, string[]>,
  ): void {
    const tail = spec.params.alignmentTail;
    if (!tail || !tail.length) return;
    const ruleFor = (id: string) => tail.find((s) => s.from === N[id]?.kind);
    const done = new Set<string>();
    const expand = (id: string) => {
      if (done.has(id)) return;
      done.add(id);
      const rule = ruleFor(id);
      if (!rule) return;
      const index = rule.dir === "out" ? realOut : realIn;
      const targets = (index[rule.rel]?.[id] || [])
        .filter((t) => N[t])
        .slice()
        .sort(byNumThenCode);
      if (!targets.length) return;
      childrenOf[id] = [...(childrenOf[id] || []), ...targets];
      targets.forEach(expand);
    };
    // Seed from every node a rule can start from. Nodes only reachable this way
    // (standards, components) never head the content tree, so they surface solely
    // where a real lesson/activity pulls them in — attaching to an unreferenced one
    // is harmless (it stays unrendered).
    data.nodes.forEach((n) => {
      if (tail.some((s) => s.from === n.kind)) expand(n.id);
    });
  }

  // Label-tree: containment tree restricted to a set of LC labels. `reverse`
  // walks the edge bottom-up (target parents source); `pruneToLabel` drops any
  // branch that never reaches that label.
  function buildLabelTree(spec: Extract<ViewSpec, { shape: "label-tree" }>): Built {
    if (cache[spec.id]) return cache[spec.id];
    const inc = new Set(spec.params.includeLabels);
    const edge = spec.params.expandEdge || "hasChild";
    const reverse = !!spec.params.reverse;
    const isInc = (id: string) => N[id] && inc.has(N[id].kind);

    const childrenOf: Record<string, string[]> = {};
    const hasIncParent = new Set<string>();
    for (const s in outByRel[edge] || {}) {
      if (!isInc(s)) continue;
      for (const x of outByRel[edge][s])
        if (isInc(x.to)) {
          const p = reverse ? x.to : s;
          const c = reverse ? s : x.to;
          (childrenOf[p] ||= []).push(c);
          hasIncParent.add(c);
        }
    }
    for (const s in childrenOf) childrenOf[s].sort(byNumThenCode);

    const rootKinds = spec.params.rootKinds
      ? new Set(spec.params.rootKinds)
      : null;
    let roots = data.nodes
      .filter(
        (n) =>
          inc.has(n.kind) &&
          !hasIncParent.has(n.id) &&
          (!rootKinds || rootKinds.has(n.kind)),
      )
      .map((n) => n.id)
      .sort(byNumThenCode);

    if (spec.params.pruneToLabel) {
      const target = spec.params.pruneToLabel;
      const keep = new Set<string>();
      const seen = new Set<string>();
      const dfs = (id: string): boolean => {
        if (seen.has(id)) return keep.has(id);
        seen.add(id);
        let k = N[id] && N[id].kind === target;
        for (const c of childrenOf[id] || []) if (dfs(c)) k = true;
        if (k) keep.add(id);
        return k;
      };
      roots.forEach(dfs);
      roots = roots.filter((id) => keep.has(id));
      for (const s in childrenOf)
        childrenOf[s] = childrenOf[s].filter((c) => keep.has(c));
    }

    graftAlignmentTail(spec, childrenOf);
    return (cache[spec.id] = { roots, childrenOf });
  }

  // Progression: prereq → successor chains over one edge type. Roots are nodes
  // with an outgoing edge and no incoming one (chain starts).
  function buildProgression(spec: Extract<ViewSpec, { shape: "progression" }>): Built {
    if (cache[spec.id]) return cache[spec.id];
    const out = outByRel[spec.params.edge] || {};
    const hasIn = new Set<string>();
    const involved = new Set<string>();
    for (const s in out) {
      involved.add(s);
      for (const x of out[s]) {
        hasIn.add(x.to);
        involved.add(x.to);
      }
    }
    const childrenOf: Record<string, string[]> = {};
    for (const s in out) childrenOf[s] = out[s].map((x) => x.to);
    const roots = [...involved].filter((id) => !hasIn.has(id)).sort(byNumThenCode);
    return (cache[spec.id] = { roots, childrenOf });
  }

  // A source-filter chip hides real nodes carrying that srcKey; synthetic and
  // untagged nodes always pass.
  const srcAllowed = (id: string, sourceOn: Record<string, boolean>): boolean => {
    if (isSynth(id)) return true;
    const n = N[id];
    if (!n) return true;
    if (!n.srcKey) return true;
    return sourceOn[n.srcKey] !== false;
  };

  function viewRoots(spec: ViewSpec): string[] {
    if (spec.shape === "label-tree") return buildLabelTree(spec).roots;
    if (spec.shape === "progression") return buildProgression(spec).roots;
    if (spec.shape === "grouped-spine") return buildGroupedSpine(spec).roots;
    return buildNodeType().roots;
  }

  function viewChildren(
    spec: ViewSpec,
    id: string,
    sourceOn: Record<string, boolean>,
  ): string[] {
    const allow = (x: string) => srcAllowed(x, sourceOn);
    if (spec.shape === "label-tree")
      return (buildLabelTree(spec).childrenOf[id] || []).filter(allow);
    if (spec.shape === "progression")
      return (buildProgression(spec).childrenOf[id] || []).filter(allow);
    if (spec.shape === "grouped-spine") {
      const gs = buildGroupedSpine(spec);
      if (isSynth(id)) return (gs.childrenOf[id] || []).filter(allow);
      const n = N[id];
      if (!n) return [];
      if (spec.params.stopKind && n.kind === spec.params.stopKind) return [];
      return outTargets(id, spec.params.expandEdge).filter(allow);
    }
    // node-type
    const nt = buildNodeType();
    if (isSynth(id)) return (nt.childrenOf[id] || []).filter(allow);
    const out: string[] = [];
    for (const r in outByRel)
      for (const x of outByRel[r][id] || []) if (allow(x.to)) out.push(x.to);
    return out;
  }

  // The REAL relation linking parent→child (for the link badge). `outByRel` is
  // keyed by traversal type (folded to hasChild), so read the true type off the
  // stored adjacency entry. In a reversed tree the display edge runs child→parent.
  // The real relation between a tree parent and child, plus which way it actually
  // flows. `sourceIsParent` is true when the parent node is the edge's source (the
  // arrow points down to the child), false when the child is (the arrow points back
  // up to the parent). The server folds a few edges REVERSED onto the display
  // containment axis (a component `supports` its standard, a lesson/activity
  // `hasEducationalAlignment`s its standard, an activity `illustrates` its
  // component — see kg-export.ts::toDisplayEdges), so for those the true source is
  // the display target; everything else flows in its display direction.
  const REVERSED_DISPLAY_RELS = new Set([
    "supports",
    "hasEducationalAlignment",
    "illustrates",
  ]);
  function relBetween(
    parentId: string,
    childId: string,
  ): { rel: string; sourceIsParent: boolean } | null {
    const lookup = (from: string, to: string): string | null => {
      for (const r in outByRel) {
        const hit = (outByRel[r][from] || []).find((x) => x.to === to);
        if (hit) return hit.rel || r;
      }
      return null;
    };
    // Find the display edge either way round (a folded edge sits reversed to how
    // the tree shows it), tracking which endpoint the stored edge points from.
    let displaySource = parentId;
    let rel = lookup(parentId, childId);
    if (!rel) {
      rel = lookup(childId, parentId);
      if (rel) displaySource = childId;
    }
    if (!rel) return null;
    const realSource = REVERSED_DISPLAY_RELS.has(rel)
      ? displaySource === parentId
        ? childId
        : parentId
      : displaySource;
    return { rel, sourceIsParent: realSource === parentId };
  }

  // Colour is driven entirely by the server taxonomy (node.cat); synthetic rows
  // borrow the colour of the category they bucket by.
  function colorFor(id: string): string {
    if (isSynth(id)) {
      const m = synthMeta(id);
      if (m?.kindRoot) return "var(--color-framework)";
      const tx = m?.level && TAXO[m.level];
      return tx ? tx.color : "var(--color-plan)";
    }
    const n = N[id];
    if (!n) return "var(--color-muted)";
    const tx = n.cat && TAXO[n.cat];
    return tx ? tx.color : "var(--color-muted)";
  }

  const desc = (n: DisplayNode, lang: Lang): string =>
    lang === "en" ? n.desc_en || n.desc : n.desc;

  function nodeLabel(id: string, lang: Lang): string {
    if (isSynth(id)) return pick(lang, synthMeta(id)?.label);
    const n = N[id];
    const d = desc(n, lang) || n.code || "";
    return d.length > 84 ? `${d.slice(0, 82)}…` : d;
  }

  return {
    data,
    N,
    outByRel,
    inHasChild,
    btOut,
    btIn,
    TAXO,
    outTargets,
    synthMeta,
    srcAllowed,
    viewRoots,
    viewChildren,
    relBetween,
    colorFor,
    nodeLabel,
    desc,
  };
}
