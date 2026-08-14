/*
 * Module: server · tool group: curriculum (local sources)
 *
 * Read-only access to the active subject's curriculum graph and terminology.
 *
 * These curriculum-read tools — list_courses / get_standards — are DELIBERATELY
 * thin generic graph readers: they surface raw Learning-Commons nodes (labels +
 * properties) and their edges, and do NO projection — no chapter/week/lesson
 * vocabulary, no cooked slice. The caller (the LLM) reads the nodes and assembles
 * materials itself; keeping the logic out of the tool is the point (see
 * docs/design-notes/logic-in-the-graph.md). A course is a real `Course` node in
 * the graph — a subject whose graph has none returns []; an expert authors one.
 * To read a course's SUBTREE, use walk_graph (server/graph.ts) — the generic
 * traversal that replaced get_course.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { searchTerminology, terminologySections, coursesOf, standardsFor } from "../curriculum/index.js";

export function registerCurriculumTools(server: McpServer) {
  server.registerTool("list_courses", { title: "List courses", description: "The `Course` nodes in the active subject's graph — each a top-level content root (for CI maths: 'Outil de l'élève' and 'Guide de l'enseignant'). Returns each course's id, LC labels, and raw properties. A subject whose graph has no Course node returns []. To read a course's subtree, pass a returned id to walk_graph (direction 'out', edgeTypes ['hasPart','hasChild']).", inputSchema: {} },
    guarded(async () => asJson({ courses: coursesOf(getActiveAdapter().model()) })));

  server.registerTool("get_standards", { title: "Get the standards a node teaches", description: "Given a content node id (e.g. a Lesson found via walk_graph), return the standards-spine neighborhood it teaches: the StandardsFrameworkItem(s) it aligns to via hasEducationalAlignment — carrying the objective (OS) text — plus each SFI's LearningComponents, the illustrative Activities aligning to it, and its parent SFI for context, as raw nodes + edges. A plain walk_graph over hasPart/hasChild does NOT include this (alignment fans out across most of the graph), so this is the per-node bridge from the content tree to the spine. `nodes` is empty if the node aligns to nothing (a placeholder not yet wired to the spine).", inputSchema: { nodeId: z.string() } },
    guarded(async (a: { nodeId: string }) => { const s = standardsFor(getActiveAdapter().model(), a.nodeId); return s ? asJson(s) : asJson({ error: `Node '${a.nodeId}' not found in the graph.` }); }));

  server.registerTool("get_terminology", { title: "Get terminology (FR/Wolof)", description: "Search the MOHEBS French/Wolof terminology used as the fallback when the KG lacks a term's wording. Returns [] if nothing matches — then say the wording is missing rather than invent it.", inputSchema: { query: z.string(), limit: z.number().int().optional() } },
    guarded(async (a: { query: string; limit?: number }) => asJson({ query: a.query, results: searchTerminology(a.query, a.limit ?? 20) })));

  server.registerTool("terminology_sections", { title: "Terminology sections", description: "List terminology sections and entry counts.", inputSchema: {} },
    guarded(async () => asJson(terminologySections())));
}
