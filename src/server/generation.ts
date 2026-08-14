/*
 * Module: server · tool group: generation (subject-agnostic)
 *
 * The generation prompt for a deliverable. Curriculum DATA is no longer loaded
 * here — generation reads it from the graph (list_courses / walk_graph /
 * get_standards); the old get_generation_context (adapter.buildGenerationContext)
 * is gone with the adapter's cooked projection. Subject-specific generation tools
 * (e.g. CI maths example-domain variety) live in server/ci-maths.ts.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { asJson, guarded, badDeliverable } from "./shared.js";
import { sourcePath } from "../context/index.js";
import { getActiveAdapter } from "../adapters/index.js";

export function registerGenerationTools(server: McpServer) {
  server.registerTool("get_prompt", { title: "Get generation prompt", description: "Return the generation prompt for one of the active subject's deliverables (its DeliverableSpec.promptFile). 'deliverable' is a deliverable key — for CI maths, 'manual' or 'lessons'. The prompt tells you which graph tools to read (list_courses / walk_graph / get_standards) for the curriculum itself.", inputSchema: { deliverable: z.string() } },
    guarded(async (a: { deliverable: string }) => {
      const bad = badDeliverable(a.deliverable); if (bad) return bad;
      const spec = getActiveAdapter().deliverables.find((d) => d.key === a.deliverable)!;
      if (!spec.promptFile) return asJson({ error: `Deliverable '${a.deliverable}' has no generation prompt configured.` });
      return asJson({ deliverable: a.deliverable, text: readFileSync(sourcePath(spec.promptFile), "utf8") });
    }));
}
