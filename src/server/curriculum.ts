/*
 * Module: server · tool group: curriculum (local sources)
 *
 * Read-only access to the active subject's curriculum graph and terminology.
 *
 * The two curriculum-read tools — list_courses / get_course — are DELIBERATELY
 * thin generic graph readers: they surface raw Learning-Commons nodes (labels +
 * properties) and their edges, and do NO projection — no chapter/week/lesson
 * vocabulary, no cooked slice. The caller (the LLM) reads the nodes and assembles
 * materials itself; keeping the logic out of the tool is the point (see
 * docs/design-notes/logic-in-the-graph.md). A course is a real `Course` node in
 * the graph — a subject whose graph has none returns []; an expert authors one.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { searchTerminology, terminologySections, coursesOf, courseSubgraph } from "../curriculum/index.js";

export function registerCurriculumTools(server: McpServer) {
  server.registerTool("list_courses", { title: "List courses", description: "The `Course` nodes in the active subject's graph — each a top-level content root (for CI maths: 'Outil de l'élève' and 'Guide de l'enseignant'). Returns each course's id, LC labels, and raw properties. A subject whose graph has no Course node returns []. Pass a returned id to get_course.", inputSchema: {} },
    guarded(async () => asJson({ courses: coursesOf(getActiveAdapter().model()) })));

  server.registerTool("get_course", { title: "Get a course's nodes", description: "Return the subtree under one Course as raw graph: every descendant node (reached via hasPart/hasChild), plus any InstructionalRoutine a descendant applies via usesRoutine and that routine's own step routines + Materials — each with its LC labels and properties, and the edges among them. NO projection — read the nodes and assemble the material yourself. 'course' is a Course id from list_courses.", inputSchema: { course: z.string() } },
    guarded(async (a: { course: string }) => { const sub = courseSubgraph(getActiveAdapter().model(), a.course); return sub ? asJson(sub) : asJson({ error: `Course '${a.course}' not found. Call list_courses for available course ids.` }); }));

  server.registerTool("get_terminology", { title: "Get terminology (FR/Wolof)", description: "Search the MOHEBS French/Wolof terminology used as the fallback when the KG lacks a term's wording. Returns [] if nothing matches — then say the wording is missing rather than invent it.", inputSchema: { query: z.string(), limit: z.number().int().optional() } },
    guarded(async (a: { query: string; limit?: number }) => asJson({ query: a.query, results: searchTerminology(a.query, a.limit ?? 20) })));

  server.registerTool("terminology_sections", { title: "Terminology sections", description: "List terminology sections and entry counts.", inputSchema: {} },
    guarded(async () => asJson(terminologySections())));
}
