/*
 * Recipe: edit_node (generic)
 *
 * The single field-edit verb: change a node's `content`, `position`, display
 * `title`, and/or ANY OTHER canonical LC property (via the freeform `properties`
 * bag) in ONE atomic draft edit. It consolidated the separate set_content +
 * reposition tools and adds title editing. The dedicated fields are applied by
 * the SAME primitives the old verbs used — `reposition` for the ordinal (mirrors
 * order into the node's raw path[s]), `setContent` for MATERIAL_CONTENT_PATH — so
 * their behaviour is unchanged; only the surface consolidated.
 *
 * The `properties` bag mirrors add_node's create-time bag: each entry writes to
 * `raw.<key>` (nested-merge), so a node's raw LC props can be AMENDED after
 * creation without a new named argument every time (e.g. `metadata.assemblyGuide`,
 * which was write-once at add_nodes before). It is the safe re-introduction of the
 * removed upsert_property: a PROTECTED_RAW_PATHS denylist refuses the paths that
 * must stay consistent for re-parsing — LC identity (normalizedType / role / id)
 * and the mirrored fields that already have a dedicated argument (the ordinal,
 * the title/text, the content), which write EVERY mirror path in sync where the
 * bag would touch only one. Everything else under raw.* is fair game.
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
  properties?: Record<string, unknown>;  // amend any other canonical LC prop → raw.<key> (e.g. metadata.assemblyGuide)
};

// Raw paths the `properties` bag must NOT touch (keys are relative to `raw`).
// Two kinds: LC IDENTITY the parser derives a node's kind/role/id from, and
// MIRRORED fields whose dedicated argument (position / title / content) writes
// every mirror path at once — a lone bag write to one of them would desync.
const PROTECTED_RAW_PATHS = [
  "normalizedType",
  "normalizedStatementType",
  "metadata.role",
  "identifier",
  "position",         // ordinal mirror — use `position`
  "metadata.order",   // ordinal mirror — use `position`
  "description",      // title mirror — use `title`
  "content",          // Material payload — use `content`
] as const;

// A bag key is protected if it collides with any protected path on the SAME
// dotted branch: it IS the path, sits ABOVE it (writing `metadata` would clobber
// `metadata.role`), or sits BELOW it. Segment-wise so `metadata` never matches an
// unrelated `metadataFoo`.
function isProtectedRawKey(key: string): boolean {
  return PROTECTED_RAW_PATHS.some(
    (protectedPath) => key === protectedPath || key.startsWith(`${protectedPath}.`) || protectedPath.startsWith(`${key}.`),
  );
}

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
    // The freeform bag: each entry amends raw.<key> (nested-merge, so writing
    // `metadata.assemblyGuide` sits beside `metadata.role` rather than replacing
    // metadata). undefined is skipped — Firestore rejects it, and an absent value
    // must leave no key behind. Protected keys are already refused in validate.
    for (const [key, value] of Object.entries(args.properties ?? {})) {
      if (value === undefined) continue;
      properties = writeAtPath(properties, `raw.${key}`, value);
    }
    return { ...node, properties };
  });
  return { nodes, edges: graph.edges };
}

export const editNode: GraphMutation<EditNodeArgs> = {
  name: "editNode",
  describe: (args) => {
    const fields: string[] = (["content", "position", "title", "title_en", "summary"] as const).filter((field) => args[field] !== undefined);
    // Name the bag's own keys so the diff description reads "…(metadata.assemblyGuide)".
    fields.push(...Object.keys(args.properties ?? {}));
    return `edit node '${args.nodeId}' (${fields.join(", ") || "no fields"})`;
  },
  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (!nodeById(base, args.nodeId)) {
      errors.push(`edit_node: node '${args.nodeId}' does not exist in the draft.`);
    }

    const bagKeys = args.properties ? Object.keys(args.properties) : [];
    const editsSomething = args.content !== undefined || args.position !== undefined || args.title !== undefined || args.title_en !== undefined || args.summary !== undefined || bagKeys.length > 0;
    if (!editsSomething) {
      errors.push(`edit_node: provide at least one of content / position / title / title_en / summary / properties to edit.`);
    }

    // The freeform bag must be a plain key→value object, and no key may collide
    // with a protected raw path (LC identity, or a mirrored field with its own arg).
    if (args.properties !== undefined) {
      if (typeof args.properties !== "object" || args.properties === null || Array.isArray(args.properties)) {
        errors.push(`edit_node: 'properties' must be an object mapping canonical LC prop names to values.`);
      } else {
        for (const key of bagKeys) {
          if (key.length === 0) {
            errors.push(`edit_node: 'properties' has an empty key.`);
          } else if (isProtectedRawKey(key)) {
            errors.push(`edit_node: 'properties.${key}' is a protected path (LC identity, or a mirrored field — edit the ordinal via 'position', the title via 'title', the content via 'content').`);
          }
        }
      }
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
    const hasBag = args.properties !== undefined && Object.keys(args.properties).length > 0;
    if (args.title !== undefined || args.title_en !== undefined || args.summary !== undefined || hasBag) {
      graph = applyDisplayFields(graph, args);
    }
    return graph;
  },
};
