/*
 * Layer: services · module: glossary
 *
 * The three glossary mutations — addTerms / editTerm / removeTerms — as plain
 * GraphMutations run through the shared two-phase framework (runGraphMutation),
 * so each gets the confirm token, structural rules, audit, and role gate for
 * free, exactly like the curriculum verbs.
 *
 * They build/patch `LexiconEntry` nodes DIRECTLY (not via the generic add_node
 * recipe or the create_node primitive) on purpose: both of those reject a label
 * or kind the namespace hasn't seen, which would make the very first term in a
 * fresh, empty glossary namespace impossible to create. Working on the graph
 * directly sidesteps that bootstrap wall while still riding the framework.
 * Lexicon nodes carry no edges, so the no-orphan rule is trivially satisfied.
 */
import type { GraphMutation, MutationGraph, MutationNode } from "../kg-store/index.js";
import { buildEntryProps, buildLexiconNode, hasAnyRendering, isLexiconNode, mergeEntry, parseEntry, type LexiconEntryInput } from "./model.js";

const nodeById = (graph: MutationGraph, id: string): MutationNode | undefined =>
  graph.nodes.find((node) => node.id === id);

// ── add_terms ────────────────────────────────────────────────────────────────
// Each entry's id is minted by the tool layer (like add_nodes) so dry-run and
// confirm hash to the same args and produce the identical node.
export type AddTermsArgs = {
  namespace: string;
  entries: Array<LexiconEntryInput & { newNodeId: string }>;
};

export const addTerms: GraphMutation<AddTermsArgs> = {
  name: "addTerms",
  describe: (args) => `add ${args.entries.length} lexicon term(s)`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    const seen = new Set<string>();
    args.entries.forEach((entry, index) => {
      if (!hasAnyRendering(entry.renderings)) errors.push(`add_terms: entry ${index} has no renderings — supply at least one language (e.g. { fr, wo }).`);
      if (seen.has(entry.newNodeId)) errors.push(`add_terms: minted id '${entry.newNodeId}' is used twice in this batch (retry).`);
      seen.add(entry.newNodeId);
      if (nodeById(base, entry.newNodeId)) errors.push(`add_terms: minted id '${entry.newNodeId}' already exists (retry).`);
    });
    return { errors, warnings: [] };
  },
  apply: (base, args) => ({
    nodes: [...base.nodes, ...args.entries.map((entry) => buildLexiconNode(entry, entry.newNodeId, args.namespace))],
    edges: base.edges,
  }),
};

// ── edit_term ────────────────────────────────────────────────────────────────
// Patch one entry in place (renderings merge; other fields replace). The id is
// stable, so no rename is possible.
export type EditTermArgs = {
  namespace: string;
  id: string;
  patch: Partial<LexiconEntryInput>;
};

export const editTerm: GraphMutation<EditTermArgs> = {
  name: "editTerm",
  describe: (args) => `edit lexicon term '${args.id}'`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    const target = nodeById(base, args.id);
    if (!target) errors.push(`edit_term: term '${args.id}' does not exist.`);
    else if (!isLexiconNode(target)) errors.push(`edit_term: node '${args.id}' is not a lexicon term.`);
    else {
      const merged = mergeEntry(parseEntry(target), args.patch);
      if (!hasAnyRendering(merged.renderings)) errors.push(`edit_term: the edit would leave term '${args.id}' with no renderings.`);
    }
    return { errors, warnings: [] };
  },
  apply: (base, args) => {
    const target = nodeById(base, args.id);
    if (!target || !isLexiconNode(target)) return base; // let validate report it
    const merged = mergeEntry(parseEntry(target), args.patch);
    return {
      nodes: base.nodes.map((node) =>
        node.id === args.id ? { ...node, properties: buildEntryProps(merged) } : node,
      ),
      edges: base.edges,
    };
  },
};

// ── remove_terms ─────────────────────────────────────────────────────────────
export type RemoveTermsArgs = {
  namespace: string;
  ids: string[];
};

export const removeTerms: GraphMutation<RemoveTermsArgs> = {
  name: "removeTerms",
  describe: (args) => `remove ${args.ids.length} lexicon term(s)`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    const seen = new Set<string>();
    args.ids.forEach((id) => {
      if (seen.has(id)) errors.push(`remove_terms: id '${id}' is listed twice.`);
      seen.add(id);
      const target = nodeById(base, id);
      if (!target) errors.push(`remove_terms: term '${id}' does not exist.`);
      else if (!isLexiconNode(target)) errors.push(`remove_terms: node '${id}' is not a lexicon term.`);
    });
    return { errors, warnings: [] };
  },
  apply: (base, args) => {
    const drop = new Set(args.ids);
    return {
      nodes: base.nodes.filter((node) => !drop.has(node.id)),
      // Lexicon nodes carry no edges, but drop any incident edge defensively.
      edges: base.edges.filter((edge) => !drop.has(edge.from) && !drop.has(edge.to)),
    };
  },
};
