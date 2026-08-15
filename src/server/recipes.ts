/*
 * Module: server · tool group: node field edits (edit_node)
 *
 * edit_node is the single field-edit verb: change a node's content, position,
 * and/or display title in one atomic draft edit. It consolidated the separate
 * set_content + reposition tools and added title editing (which had no verb after
 * upsert_property was removed). Node CREATION is add_nodes (server/authoring.ts);
 * re-parenting is move_node.
 *
 * It shares the graph-mutation envelope: a dry-run returns a diff + warnings +
 * confirmationToken (no state change); the confirm re-checks the token and
 * applies to the DRAFT only.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { runGraphMutation, kgNamespace, type MutationGraph } from "../kg-store/index.js";
import { editNode } from "../kg-recipes/index.js";
import type { SubjectAdapter } from "../types.js";

function bind(adapter: SubjectAdapter): { namespace: string; coverage: (g: MutationGraph) => string[] } {
  return {
    namespace: kgNamespace(activeWorkspace(), adapter.grade, adapter.subject),
    coverage: (g) => adapter.coverageWarnings?.(g as never) ?? [],
  };
}

export function registerRecipeTools(server: McpServer) {
  server.registerTool(
    "edit_node",
    {
      title: "Edit a node's fields",
      description:
        "Edit a node IN PLACE in ONE atomic draft edit — the single field-edit verb (it replaced set_content + reposition and added title editing). Pass `nodeId` and AT LEAST ONE of: `content` (load-bearing text, canonical LC Material.content), `position` (ordinal among siblings — membership is the containment edge, so this NEVER cascades; only labels that carry a position in LC — LessonGrouping/Lesson/Activity/routine steps — have one), `title` (display name — normalized to the node's title/text field per its label), `title_en` (English mirror). A nonexistent `nodeId` is BLOCKED; to remove content, delete the node instead. Edit in place — do NOT delete + re-add (that cascades the subtree, drops every incident edge, and mints a new id). REQUIRES CONFIRMATION. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        nodeId: z.string(),
        content: z.string().optional(),
        position: z.number().optional(),
        title: z.string().optional(),
        title_en: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { nodeId: string; content?: string; position?: number; title?: string; title_en?: string; confirm?: boolean; confirmationToken?: string }) => {
      const { namespace, coverage } = bind(getActiveAdapter());
      const result = await runGraphMutation({
        namespace,
        mutation: editNode,
        args: { namespace, nodeId: a.nodeId, content: a.content, position: a.position, title: a.title, title_en: a.title_en },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage,
      });
      return asJson(result);
    }),
  );
}
