// ── Layer: app · module: server ──────────────────────────────────────────────
// Front door of the server module: assemble the MCP server from the tool groups.
// The tool groups are the only layer that reads the active adapter (via
// getActiveAdapter) and dispatches to it, so the service modules stay unaware
// of the adapter layer.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContextTools } from "./context.js";
import { registerCurriculumTools } from "./curriculum.js";
import { registerGenerationTools } from "./generation.js";
import { registerPreviewTools } from "./preview.js";
import { registerCiMathsTools } from "./ci-maths.js";
import { registerDocumentTools } from "./documents.js";
import { registerLifecycleTools } from "./lifecycle.js";
import { registerStructuralTools } from "./structural.js";
import { registerRecipeTools } from "./recipes.js";
import { registerCapabilityTools } from "./capabilities.js";
import { registerAuditTools } from "./audit.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "senegal-mohebs-tlm-server", version: "0.4.0" });
  registerContextTools(server);      // set_context, get_context
  registerCurriculumTools(server);   // list_units, get_curriculum, terminology
  registerGenerationTools(server);   // get_prompt, get_generation_context
  registerPreviewTools(server);      // preview_generation, create_preview_upload_url (draft-resolved, isolated from published)
  registerCiMathsTools(server);        // suggest_fresh_domain, domain_usage (CI-CI-maths-specific)
  registerDocumentTools(server);     // reconcile, upload/download, record/log
  registerLifecycleTools(server);    // diff_draft, upsert_property, publish_draft, discard_draft
  registerStructuralTools(server);   // create_node, link_nodes, unlink_nodes, delete_node (raw structural verbs)
  registerRecipeTools(server);       // add_lesson, add_chapter, move_lesson, split_chapter, renumber (composite recipes)
  registerCapabilityTools(server);   // get_capabilities (read-only mirror of what the caller can do)
  registerAuditTools(server);        // read_audit (approver-only, read-only reader over the append-only audit log)
  return server;
}
