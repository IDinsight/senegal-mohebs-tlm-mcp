// ── Module: server · tool group: teaching context ────────────────────────────
// Choosing the active grade/subject. These are the only tools that work with no
// context set (they're how you set it), so they are not wrapped in guarded().
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson } from "./shared.js";
import { activateContext } from "../activate.js";
import { getActiveContext, listAvailableContexts } from "../context/index.js";

export function registerContextTools(server: McpServer) {
  server.registerTool("set_context", { title: "Set grade & subject", description: "Choose the grade (e.g. 'ci') and subject (e.g. 'maths') to work on. This selects which local sources load and which Firebase namespace documents and history live under, and MUST be set before any other tool. If you don't know which to use, call get_context to list the installed options, then ask the user.", inputSchema: { grade: z.string(), subject: z.string() } },
    async (a) => { const r = await activateContext(a.grade, a.subject); return asJson(r.ok ? { ok: true, active: r.context, available: listAvailableContexts() } : r); });

  server.registerTool("get_context", { title: "Get grade & subject", description: "Return the currently selected grade/subject (null if none is set yet) and every installed grade/subject option. Use this to discover what's available, then set_context.", inputSchema: {} },
    async () => asJson({ active: getActiveContext(), available: listAvailableContexts() }));
}
