/*
 * Module: server · tool group: curriculum (local sources)
 *
 * Read-only access to the active subject's curriculum graph and terminology.
 *
 * `get_standards` is a thin generic graph reader: it surfaces raw Learning-Commons
 * nodes (labels + properties) and their edges, and does NO projection — no
 * chapter/week/lesson vocabulary, no cooked slice. The caller (the LLM) reads the
 * nodes and assembles materials itself; keeping the logic out of the tool is the
 * point (see docs/design-notes/logic-in-the-graph.md). To find a subject's Course
 * content roots, use namespace_stats (its `roots`); to read a course's SUBTREE,
 * use walk_graph (server/graph.ts) — the generic traversal that replaced get_course.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { terminologySections, standardsFor } from "../curriculum/index.js";
import { effectiveTerms, filterByQuery } from "./glossary-read.js";

export function registerCurriculumTools(server: McpServer) {
  server.registerTool("get_standards", { title: "Get the standards a node teaches", description: "Given a content node id (e.g. a Lesson found via walk_graph), return the standards-spine neighborhood it teaches: the StandardsFrameworkItem(s) it aligns to via hasEducationalAlignment — carrying the objective (OS) text — plus each SFI's LearningComponents, the illustrative Activities aligning to it, and its parent SFI for context, as raw nodes + edges. A plain walk_graph over hasPart/hasChild does NOT include this (alignment fans out across most of the graph), so this is the per-node bridge from the content tree to the spine. `nodes` is empty if the node aligns to nothing (a placeholder not yet wired to the spine).", inputSchema: { nodeId: z.string() } },
    guarded(async (a: { nodeId: string }) => { const s = standardsFor(getActiveAdapter().model(), a.nodeId); return s ? asJson(s) : asJson({ error: `Node '${a.nodeId}' not found in the graph.` }); }));

  server.registerTool("get_terminology", { title: "Get terminology (FR/Wolof)", description: "Search the workspace's French/Wolof lexicon for a term's established wording (from the store-backed glossary, or the on-disk MOHEBS terminology when a workspace has no glossary yet). Each result carries `francais`/`wolof` plus the full `renderings` map. Returns [] if nothing matches — then say the wording is missing rather than invent it.", inputSchema: { query: z.string(), limit: z.number().int().optional() } },
    guarded(async (a: { query: string; limit?: number }) => asJson({ query: a.query, results: filterByQuery(await effectiveTerms(), a.query, a.limit ?? 20) })));

  server.registerTool("terminology_sections", { title: "Terminology sections", description: "List terminology sections and entry counts.", inputSchema: {} },
    guarded(async () => asJson(terminologySections())));
}
