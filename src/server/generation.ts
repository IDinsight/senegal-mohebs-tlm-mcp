/*
 * Module: server · tool group: generation (subject-agnostic)
 *
 * What an agent loads right before generating, delegated to the active adapter:
 * the deliverable's prompt and the composite generation context. Subject-
 * specific generation tools (e.g. CI CI maths example-domain variety) live in
 * server/ci-maths.ts.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { asJson, guarded, badDeliverable } from "./shared.js";
import { sourcePath } from "../context/index.js";
import { getActiveAdapter } from "../adapters/index.js";

export function registerGenerationTools(server: McpServer) {
  server.registerTool("get_prompt", { title: "Get generation prompt", description: "Return the generation prompt for one of the active subject's deliverables (its DeliverableSpec.promptFile). 'deliverable' is a deliverable key — for CI maths, 'manual' or 'lessons'.", inputSchema: { deliverable: z.string() } },
    guarded(async (a: { deliverable: string }) => {
      const bad = badDeliverable(a.deliverable); if (bad) return bad;
      const spec = getActiveAdapter().deliverables.find((d) => d.key === a.deliverable)!;
      if (!spec.promptFile) return asJson({ error: `Deliverable '${a.deliverable}' has no generation prompt configured.` });
      return asJson({ deliverable: a.deliverable, text: readFileSync(sourcePath(spec.promptFile), "utf8") });
    }));

  server.registerTool("get_generation_context", { title: "Get generation context", description: "One call to load before generating: curriculum for the unit, plus subject-specific context (for CI maths: established characters, a fresh example-domain suggestion, and — for the teacher guide — the manual to build on). 'unit' is the scope value (CI maths: chapter number); 'deliverable' is a deliverable key (CI maths: 'manual' or 'lessons').", inputSchema: { unit: z.number().int(), deliverable: z.string() } },
    guarded(async (a: { unit: number; deliverable: string }) => badDeliverable(a.deliverable) ?? asJson(await getActiveAdapter().buildGenerationContext(a.unit, a.deliverable))));
}
