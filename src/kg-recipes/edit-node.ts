/*
 * Recipe: edit_node (generic)
 *
 * The single field-edit verb: change a node's `content`, `position`, and/or
 * display `title` in ONE atomic draft edit. It consolidated the separate
 * set_content + reposition tools and adds title editing (which had no verb after
 * upsert_property was removed). Each provided field is applied by the SAME
 * primitive the old verbs used — `reposition` for the ordinal (mirrors order into
 * the node's raw path[s]), `setContent` for MATERIAL_CONTENT_PATH — so behaviour
 * is unchanged; only the surface consolidated.
 *
 * It is deliberately NOT a generic set_property over arbitrary raw.* paths (that
 * was upsert_property, removed): each field writes a KNOWN, safe target, so a
 * caller can't corrupt LC identity fields (labels / normalizedType / the ordinal
 * mirrors) that must stay consistent for re-parsing.
 */

import { writeAtPath, type GraphMutation, type MutationGraph } from "../kg-store/index.js";
import { RecipeCommon, nodeById } from "./shared.js";
import { reposition } from "./reposition.js";
import { setContent } from "./set-content.js";

export type EditNodeArgs = RecipeCommon & {
  nodeId: string;
  content?: string;     // load-bearing content (canonical LC Material.content)
  position?: number;    // ordinal among siblings
  title?: string;       // display title (→ normalized title/text + raw.description)
  title_en?: string;    // English mirror (→ raw.metadata.en.description)
  summary?: string;     // cross-cutting summary (→ raw.metadata.summary) — e.g. a routine/formatter's blurb
};

// A grouping (Course/LessonGrouping/StandardsFramework) stores its display name
// in `title`; a content leaf (Lesson/Activity/Material/…) in `text`. Same split
// the create path uses, so an edited title re-parses like a seeded one.
const GROUPING_LABELS = new Set(["Course", "LessonGrouping", "StandardsFramework"]);

// Write the display fields to their known targets: the title to the normalized
// field (title vs text by grouping-ness) + its raw mirror; the English title to
// its metadata mirror; the summary to raw.metadata.summary (a routine/formatter's
// cross-cutting blurb, surfaced by list_catalog / get_catalog_entry / walk_graph —
// the one field that had no edit verb, needed to author or clean an entry's blurb).
function applyDisplayFields(graph: MutationGraph, args: EditNodeArgs): MutationGraph {
  const nodes = graph.nodes.map((node) => {
    if (node.id !== args.nodeId) {
      return node;
    }
    let properties = node.properties;
    if (args.title !== undefined) {
      const isGrouping = (node.labels ?? []).some((label) => GROUPING_LABELS.has(label));
      properties = writeAtPath(properties, isGrouping ? "title" : "text", args.title);
      properties = writeAtPath(properties, "raw.description", args.title);
    }
    if (args.title_en !== undefined) {
      properties = writeAtPath(properties, "raw.metadata.en.description", args.title_en);
    }
    if (args.summary !== undefined) {
      properties = writeAtPath(properties, "raw.metadata.summary", args.summary);
    }
    return { ...node, properties };
  });
  return { nodes, edges: graph.edges };
}

export const editNode: GraphMutation<EditNodeArgs> = {
  name: "editNode",
  describe: (args) => {
    const fields = (["content", "position", "title", "title_en", "summary"] as const).filter((field) => args[field] !== undefined);
    return `edit node '${args.nodeId}' (${fields.join(", ") || "no fields"})`;
  },
  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (!nodeById(base, args.nodeId)) {
      errors.push(`edit_node: node '${args.nodeId}' does not exist in the draft.`);
    }

    const editsSomething = args.content !== undefined || args.position !== undefined || args.title !== undefined || args.title_en !== undefined || args.summary !== undefined;
    if (!editsSomething) {
      errors.push(`edit_node: provide at least one of content / position / title / title_en / summary to edit.`);
    }
    if (args.content !== undefined && (typeof args.content !== "string" || args.content.length === 0)) {
      errors.push(`edit_node: 'content' must be a non-empty string (to remove content, delete the node instead).`);
    }
    if (args.position !== undefined && (typeof args.position !== "number" || !Number.isFinite(args.position))) {
      errors.push(`edit_node: 'position' must be a number.`);
    }
    if (args.title !== undefined && (typeof args.title !== "string" || args.title.length === 0)) {
      errors.push(`edit_node: 'title' must be a non-empty string.`);
    }
    if (args.summary !== undefined && (typeof args.summary !== "string" || args.summary.length === 0)) {
      errors.push(`edit_node: 'summary' must be a non-empty string.`);
    }
    return { errors, warnings: [] };
  },
  apply: (base, args) => {
    if (!nodeById(base, args.nodeId)) {
      return base;
    }

    // Each field is applied by the same primitive the retired verbs used, so the
    // combined edit is exactly "do reposition, then set_content, then set title".
    let graph = base;
    if (args.position !== undefined) {
      graph = reposition.apply(graph, { namespace: args.namespace, nodeId: args.nodeId, position: args.position });
    }
    if (args.content !== undefined) {
      graph = setContent.apply(graph, { namespace: args.namespace, nodeId: args.nodeId, content: args.content });
    }
    if (args.title !== undefined || args.title_en !== undefined || args.summary !== undefined) {
      graph = applyDisplayFields(graph, args);
    }
    return graph;
  },
};
