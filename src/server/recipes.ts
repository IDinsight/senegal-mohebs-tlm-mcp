/*
 * Module: server · tool group: ordinal + content edits
 *
 * Two generic, subject-agnostic graph edits that aren't node/edge creation:
 * `reposition` (set a node's ordinal) and `set_content` (rewrite a Material's
 * load-bearing content). Node CREATION is now the typed authoring tools
 * (server/authoring.ts); these two remain generic because ordinal and content
 * are the same concept for every label.
 *
 * Both share the graph-mutation envelope: a dry-run returns a diff + warnings +
 * confirmationToken (no state change); the confirm re-checks the token and
 * applies to the DRAFT only.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { runGraphMutation, kgNamespace, type MutationGraph } from "../kg-store/index.js";
import { reposition, setContent } from "../kg-recipes/index.js";
import type { SubjectAdapter } from "../types.js";

function bind(adapter: SubjectAdapter): { namespace: string; coverage: (g: MutationGraph) => string[] } {
  return {
    namespace: kgNamespace(activeWorkspace(), adapter.grade, adapter.subject),
    coverage: (g) => adapter.coverageWarnings?.(g as never) ?? [],
  };
}

export function registerRecipeTools(server: McpServer) {
  // ── reposition ──────────────────────────────────────────────────────────────
  server.registerTool(
    "reposition",
    {
      title: "Set a node's position",
      description:
        "Set a node's `position` — its ordinal among its siblings — in ONE atomic draft edit. Only valid on labels that carry a position in LC (LessonGrouping, Lesson, Activity, and routine steps); Course/Material/StandardsFrameworkItem have none. Membership is the containment edge, so this NEVER cascades. REQUIRES CONFIRMATION. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        nodeId: z.string(),
        position: z.number(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { nodeId: string; position: number; confirm?: boolean; confirmationToken?: string }) => {
      const { namespace, coverage } = bind(getActiveAdapter());
      const result = await runGraphMutation({
        namespace,
        mutation: reposition,
        args: { namespace, nodeId: a.nodeId, position: a.position },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage,
      });
      return asJson(result);
    }),
  );

  // ── set_content ─────────────────────────────────────────────────────────────
  server.registerTool(
    "set_content",
    {
      title: "Replace a node's content",
      description:
        "Replace a node's load-bearing `content` (canonical LC Material.content) in ONE atomic draft edit — the dedicated verb for editing content, since upsert_property is wording-only and cannot reach it. A nonexistent `nodeId` is BLOCKED; to remove content entirely, delete the node instead. REQUIRES CONFIRMATION. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        nodeId: z.string(),
        content: z.string(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { nodeId: string; content: string; confirm?: boolean; confirmationToken?: string }) => {
      const { namespace, coverage } = bind(getActiveAdapter());
      const result = await runGraphMutation({
        namespace,
        mutation: setContent,
        args: { namespace, nodeId: a.nodeId, content: a.content },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage,
      });
      return asJson(result);
    }),
  );
}
