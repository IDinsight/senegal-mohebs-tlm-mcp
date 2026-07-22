// ── Layer: app · module: server ──────────────────────────────────────────────
// Front door of the server module: assemble the MCP server from the tool groups.
// The tool groups are the only layer that reads the active profile (getActive-
// Profile) and dispatches to it, so the service modules stay unaware of profiles.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContextTools } from "./context.js";
import { registerCurriculumTools } from "./curriculum.js";
import { registerGenerationTools } from "./generation.js";
import { registerMathsTools } from "./maths.js";
import { registerDocumentTools } from "./documents.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "senegal-mohebs-tlm-server", version: "0.4.0" });
  registerContextTools(server);      // set_context, get_context
  registerCurriculumTools(server);   // list_units, get_curriculum, terminology
  registerGenerationTools(server);   // get_prompt, get_generation_context
  registerMathsTools(server);        // suggest_fresh_domain, domain_usage (maths-specific)
  registerDocumentTools(server);     // reconcile, upload/download, record/log
  return server;
}
