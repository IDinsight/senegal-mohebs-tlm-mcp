// ── Module: server · tool group: CI-CI-maths-specific ──────────────────────────────
// Tools that only make sense for the CI-CI CI maths storybook model (example-domain
// rotation — keeping each chapter's object families fresh). MCP tools register
// once at startup, before a context is chosen, so these are always registered
// but gated at call time on capabilities.exampleDomainRotation: for a subject
// that doesn't enable it they return "not applicable" rather than misleading
// data. Delegation goes through the active adapter's optional
// suggestFreshDomain / domainUsage methods.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asJson, guarded, needsCapability } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";

export function registerCiMathsTools(server: McpServer) {
  server.registerTool("suggest_fresh_domain", { title: "Suggest fresh example domain", description: "Suggest an unused (or least-recently-used) example domain so chapters rotate object families. Maths-specific (example-domain rotation).", inputSchema: {} },
    guarded(async () => {
      const ad = getActiveAdapter();
      const gate = needsCapability(ad.capabilities.exampleDomainRotation, "exampleDomainRotation");
      return gate ?? asJson(await ad.suggestFreshDomain!());
    }));

  server.registerTool("domain_usage", { title: "Example-domain usage", description: "Which example domains have been used, and in which chapters. Maths-specific (example-domain rotation).", inputSchema: {} },
    guarded(async () => {
      const ad = getActiveAdapter();
      const gate = needsCapability(ad.capabilities.exampleDomainRotation, "exampleDomainRotation");
      return gate ?? asJson(await ad.domainUsage!());
    }));
}
