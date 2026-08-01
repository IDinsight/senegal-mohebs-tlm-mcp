// ── Module: server · tool group: curriculum (local sources) ──────────────────
// Read-only views of the active subject's curriculum and terminology. Generic
// vocabulary: "unit" is the subject's top-level generation unit (a chapter for
// CI maths; a week for CE1 reading). Values come from the active adapter, so
// the RETURNED shapes are still subject-specific (CI CI maths returns chapitreNum/
// leconNum, etc.) even though the tool names/params are neutral.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { searchTerminology, terminologySections } from "../curriculum/index.js";

export function registerCurriculumTools(server: McpServer) {
  server.registerTool("list_units", { title: "List curriculum units", description: "All top-level curriculum units for the active subject (for CI maths: chapters — number, title, domain). Numbering may skip.", inputSchema: {} },
    guarded(async () => asJson(getActiveAdapter().listUnits())));

  server.registerTool("get_curriculum", { title: "Get unit curriculum", description: "The curriculum slice for one unit (for CI maths: a chapter's ordered lessons with components and tasks, the bilan lesson, and cross-unit progression). 'unit' is the unit's scope value (CI maths: the chapter number).", inputSchema: { unit: z.number().int() } },
    guarded(async (a: { unit: number }) => { const ad = getActiveAdapter(); const s = ad.slice(a.unit); return s ? asJson({ ...(s as object), progression: ad.progression(a.unit) }) : asJson({ error: `Unit ${a.unit} not found.` }); }));

  server.registerTool("get_terminology", { title: "Get terminology (FR/Wolof)", description: "Search the MOHEBS French/Wolof terminology used as the fallback when the KG lacks a term's wording. Returns [] if nothing matches — then say the wording is missing rather than invent it.", inputSchema: { query: z.string(), limit: z.number().int().optional() } },
    guarded(async (a: { query: string; limit?: number }) => asJson({ query: a.query, results: searchTerminology(a.query, a.limit ?? 20) })));

  server.registerTool("terminology_sections", { title: "Terminology sections", description: "List terminology sections and entry counts.", inputSchema: {} },
    guarded(async () => asJson(terminologySections())));
}
