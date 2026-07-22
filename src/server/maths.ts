// ── Module: server · tool group: maths-specific ──────────────────────────────
// Tools that only make sense for the CI-maths storybook model (example-domain
// rotation — keeping each chapter's object families fresh). MCP tools register
// once at startup, before a context is chosen, so these are always registered but
// gated at call time on capabilities.exampleDomainRotation: for a subject that
// doesn't enable it they return "not applicable" rather than misleading data.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asJson, guarded, needsCapability } from "./shared.js";
import { getActiveProfile } from "../profiles/index.js";
import { suggestFreshDomain, domainUsage } from "../generation/index.js";

export function registerMathsTools(server: McpServer) {
  server.registerTool("suggest_fresh_domain", { title: "Suggest fresh example domain", description: "Suggest an unused (or least-recently-used) example domain so chapters rotate object families. Maths-specific (example-domain rotation).", inputSchema: {} },
    guarded(async () => needsCapability(getActiveProfile().capabilities.exampleDomainRotation, "exampleDomainRotation") ?? asJson(await suggestFreshDomain())));

  server.registerTool("domain_usage", { title: "Example-domain usage", description: "Which example domains have been used, and in which chapters. Maths-specific (example-domain rotation).", inputSchema: {} },
    guarded(async () => needsCapability(getActiveProfile().capabilities.exampleDomainRotation, "exampleDomainRotation") ?? asJson(await domainUsage())));
}
