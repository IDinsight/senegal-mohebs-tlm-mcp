/*
 * Layer: app · module: server
 *
 * Front door of the server module: assemble the MCP server from the tool groups.
 * The tool groups are the only layer that reads the active adapter (via
 * getActiveAdapter) and dispatches to it, so the service modules stay unaware
 * of the adapter layer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContextTools } from "./context.js";
import { registerWorkspaceTools } from "./workspaces.js";
import { registerCurriculumTools } from "./curriculum.js";
import { registerGenerationTools } from "./generation.js";
import { registerPreviewTools } from "./preview.js";
import { registerCiMathsTools } from "./ci-maths.js";
import { registerDocumentTools } from "./documents.js";
import { registerLifecycleTools } from "./lifecycle.js";
import { registerStructuralTools } from "./structural.js";
import { registerRecipeTools } from "./recipes.js";
import { registerAuthoringTools } from "./authoring.js";
import { registerCatalogTools } from "./catalog.js";
import { registerCapabilityTools } from "./capabilities.js";
import { registerAuditTools } from "./audit.js";
import { registerHealthTools } from "./health.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "senegal-mohebs-tlm-server", version: "0.4.0" });
  registerHealthTools(server);       // ping (no datastore — transport liveness probe)
  registerContextTools(server);      // set_context, get_context
  registerWorkspaceTools(server);    // list_workspaces, create_workspace, add/remove/list_member (tenant admin)
  registerCurriculumTools(server);   // list_courses, get_course (generic node readers), terminology
  registerGenerationTools(server);   // get_prompt, get_generation_context
  registerPreviewTools(server);      // preview_generation, create_preview_upload_url (draft-resolved, isolated from published)
  registerCiMathsTools(server);      // suggest_fresh_domain, domain_usage (CI maths-specific)
  registerDocumentTools(server);     // reconcile, upload/download, record/log
  registerLifecycleTools(server);    // diff_draft, upsert_property, publish_draft, discard_draft
  registerStructuralTools(server);   // create_edge, delete_edges, delete_nodes (raw graph primitives)
  registerRecipeTools(server);       // reposition, set_content (ordinal + content edits)
  registerAuthoringTools(server);    // add_course/lesson_grouping/lesson/activity/assessment/material/learning_component/standard_framework_item/instructional_routine (typed LC adds)
  registerCatalogTools(server);      // list_catalog, use_routine (shared routine catalog — browse + copy-onto-lesson)
  registerCapabilityTools(server);   // get_capabilities (read-only mirror of what the caller can do)
  registerAuditTools(server);        // read_audit (approver-only, read-only reader over the append-only audit log)
  return server;
}
