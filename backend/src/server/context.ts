/*
 * Module: server · tool group: teaching context
 *
 * Choosing the active workspace + grade + subject. These are the only tools that
 * work with no context set (they're how you set it), so they are not wrapped in
 * guarded().
 *
 * Workspace ENTRY is the read-isolation gate (see docs/design-notes/workspaces.md):
 * a signed-in caller may only set_context into a workspace they hold a role in
 * (or are a super admin over). Unknown actors — only reachable with auth
 * disabled, i.e. local dev — are let through, preserving the permissive
 * unknown-actor policy. Once inside, reads/generation stay ungated.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson } from "./shared.js";
import { activateContext } from "../activate.js";
import { getActiveContext, listAvailableContexts } from "../context/index.js";
import { currentActor } from "../actor.js";
import { effectiveRole } from "../authz.js";
import { slug } from "../utils/index.js";

// Contexts the caller may enter. Unknown actor (auth off) sees everything;
// otherwise only workspaces where they hold a role (super admin sees all).
export function accessibleContexts() {
  const actor = currentActor();
  const all = listAvailableContexts();
  if (actor.unknown || actor.superAdmin) return all;
  return all.filter((c) => effectiveRole(actor, c.workspace) !== undefined);
}

export function registerContextTools(server: McpServer) {
  server.registerTool("set_context", { title: "Set workspace, grade & subject", description: "Choose the workspace (e.g. 'senegal'), grade (e.g. 'ci') and subject (e.g. 'maths') to work on. This selects which sources load and which Firebase namespace documents and history live under, and MUST be set before any other tool. You can only enter a workspace you have a role in. If you don't know which to use, call get_context (or list_workspaces) to list your options, then ask the user.", inputSchema: { workspace: z.string(), grade: z.string(), subject: z.string() } },
    async (a) => {
      const actor = currentActor();
      const ws = slug(a.workspace);
      // Entry gate: signed-in callers need a role in this workspace.
      if (!actor.unknown && !actor.superAdmin && effectiveRole(actor, ws) === undefined) {
        return asJson({ ok: false, error: `You have no role in workspace '${a.workspace}'. Ask a workspace admin (or a super admin) to add you.`, available: accessibleContexts() });
      }
      const r = await activateContext(a.workspace, a.grade, a.subject);
      return asJson(r.ok ? { ok: true, active: r.context, available: accessibleContexts() } : r);
    });

  server.registerTool("get_context", { title: "Get active context", description: "Return the currently selected workspace/grade/subject (null if none is set yet) and every workspace/grade/subject option you can access. Use this to discover what's available, then set_context.", inputSchema: {} },
    async () => asJson({ active: getActiveContext(), available: accessibleContexts() }));
}
