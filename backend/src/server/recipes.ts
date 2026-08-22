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
import { runGraphMutation, kgNamespace } from "../kg-store/index.js";
import { editNode } from "../kg-recipes/index.js";
import { runCatalogWrite, type WriteOutcome } from "./catalog-target.js";
import type { SubjectAdapter } from "../types.js";

function bind(adapter: SubjectAdapter): { namespace: string } {
  return { namespace: kgNamespace(activeWorkspace(), adapter.grade, adapter.subject) };
}

export function registerRecipeTools(server: McpServer) {
  server.registerTool(
    "edit_node",
    {
      title: "Edit a node's fields",
      description:
        "Edit a node IN PLACE in ONE atomic draft edit — the single field-edit verb (it replaced set_content + reposition and added title editing). Only `nodeId` is required. Every editable field is OPTIONAL and independent: supply just the ones you want to change (a single field is fine) — any unsupplied field is left untouched, never cleared. Provide AT LEAST ONE of: `content` (load-bearing text, canonical LC Material.content), `position` (ordinal among siblings — membership is the containment edge, so this NEVER cascades; only labels that carry a position in LC — LessonGrouping/Lesson/Activity/routine steps — have one), `title` (display name — normalized to the node's title/text field per its label), `title_en` (English mirror), `summary` (a routine/formatter's cross-cutting blurb → raw.metadata.summary, the field list_catalog / get_catalog_entry / walk_graph surface), `properties` (a freeform object amending ANY OTHER canonical LC prop → written under raw.<key>, nested-merge — e.g. {\"metadata.assemblyGuide\":\"…\"}; the same bag add_nodes takes at create time, so a raw prop can be amended later without a dedicated argument). `properties` REFUSES protected paths — LC identity (normalizedType / normalizedStatementType / metadata.role / identifier) and the mirrored fields that have their own argument (use `position` for the ordinal, `title` for the display name/description, `content` for the Material payload). A nonexistent `nodeId` is BLOCKED; to remove content, delete the node instead. Edit in place — do NOT delete + re-add (that cascades the subtree, drops every incident edge, and mints a new id). REQUIRES CONFIRMATION: the dry-run returns a diff + confirmationToken; confirm with confirm:true + the token. When the dry-run reports `payloadStored:true` (a large edit held server-side), confirm with ONLY confirm:true + the token — do NOT re-send `content`; otherwise re-send the same fields. DRAFT edit — publish_draft to make it live. " +
        "`catalog` (optional) edits a CATALOG LIBRARY entry instead of the active subject graph — use it to fix a stale master that use_routine / use_formatter would otherwise keep re-cloning. Pass 'workspace' (your own library), 'shared' (the cross-tenant one), or a workspace id; ids come from list_catalog / get_catalog_entry. Crossing into another workspace's or the shared library needs super_admin. TWO DIFFERENCES from a subject edit: confirming PUBLISHES the library live in one step (catalogs are not enterable contexts, so there is no publish_draft or diff_draft for them), and you must RE-SEND `catalog` on the confirm alongside the token. Note the copies already made from an entry are independent — fixing the master does not reach them; edit those in the subject graph separately.",
      inputSchema: {
        nodeId: z.string(),
        content: z.string().optional(),
        position: z.number().optional(),
        title: z.string().optional(),
        title_en: z.string().optional(),
        summary: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        catalog: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { nodeId: string; content?: string; position?: number; title?: string; title_en?: string; summary?: string; properties?: Record<string, unknown>; catalog?: string; confirm?: boolean; confirmationToken?: string }) => {
      const editInNamespace = async (namespace: string): Promise<WriteOutcome> => {
        const result = await runGraphMutation({
          namespace,
          mutation: editNode,
          args: { namespace, nodeId: a.nodeId, content: a.content, position: a.position, title: a.title, title_en: a.title_en, summary: a.summary, properties: a.properties },
          confirm: a.confirm,
          token: a.confirmationToken,
          // edit_node passes its complete args straight through (no minting/rebuild
          // per phase), so a big content rewrite can be parked at dry-run and
          // confirmed with just the token — see runGraphMutation storePayload.
          storePayload: true,
        });
        return result as WriteOutcome;
      };

      // `catalog` redirects the edit to a catalog library, which also publishes on
      // confirm (catalogs have no publish_draft) — see catalog-target.ts.
      if (a.catalog) {
        return asJson(await runCatalogWrite(a.catalog, a.confirm, editInNamespace));
      }
      return asJson(await editInNamespace(bind(getActiveAdapter()).namespace));
    }),
  );
}
