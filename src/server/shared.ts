// ── Module: server · internal helpers ────────────────────────────────────────
// Tool helpers that depend on app-layer state (the active profile / context), so
// they live inside the server module rather than in utils (which stays a leaf).
// The pure asJson primitive comes from the utils barrel and is re-exported here
// so each tool group imports all its helpers from one place ("./shared.js").
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asJson, type ToolResult } from "../utils/index.js";
import { getActiveProfile } from "../profiles/index.js";
import { ContextNotSetError } from "../context/index.js";

export { asJson, type ToolResult };

// Wrap a tool handler so that, when no grade/subject is active, the server asks
// the caller to pick one (and lists the options) instead of throwing. Every
// source- or bucket-dependent tool is registered through this.
export const guarded = <A>(fn: (a: A) => ToolResult | Promise<ToolResult>) => async (a: A): Promise<ToolResult> => {
  try {
    return await fn(a);
  } catch (e) {
    if (e instanceof ContextNotSetError) {
      return asJson({
        needsContext: true,
        message: "No grade/subject is selected yet. Ask the user which grade and subject to work on, then call set_context. Available options are listed below.",
        available: e.available,
      });
    }
    throw e;
  }
};

// Validate a deliverable key against the active profile. Returns an error
// ToolResult when the key isn't one this subject produces, so the openness of
// the deliverable set is enforced at runtime (the schema can't be a fixed enum,
// since the valid keys depend on the context chosen at runtime).
export const badDeliverable = (key: string): ToolResult | null => {
  const keys = getActiveProfile().deliverables.map((d) => d.key);
  return keys.includes(key) ? null : asJson({ error: `Unknown deliverable '${key}' for the active subject. Valid deliverables: ${keys.join(", ")}.` });
};

// Guard a capability-specific tool: returns an explanatory ToolResult when the
// active subject's profile doesn't enable the capability, else null so the tool
// runs. Keeps capability-only tools from returning misleading empty data for
// subjects they don't apply to.
export const needsCapability = (enabled: boolean, cap: string): ToolResult | null =>
  enabled ? null : asJson({ notApplicable: true, message: `Not applicable for the active subject: this tool requires the '${cap}' capability, which this subject's profile does not enable.` });

// Human confirmation for outward-facing / state-changing tools (file uploads,
// history writes). Returns a ToolResult (→ caller does NO side effect) unless the
// user has approved, in which case it returns null (→ proceed). "Best available"
// gate across clients:
//   • Client supports MCP elicitation → ask the USER directly via a dialog. This
//     is the strong gate — the agent cannot bypass it with confirm:true.
//   • Otherwise → fall back to the agent-mediated two-step: no side effect until
//     the tool is re-called with confirm:true (the agent is told to ask first).
export async function requireConfirmation(server: McpServer, confirm: boolean | undefined, summary: string): Promise<ToolResult | null> {
  const caps = server.server.getClientCapabilities();
  if (caps?.elicitation) {
    try {
      const res = await server.server.elicitInput({
        message: `Confirm before proceeding — about to ${summary}. Proceed?`,
        requestedSchema: {
          type: "object",
          properties: { confirm: { type: "boolean", title: "Proceed?", description: `Approve: ${summary}` } },
          required: ["confirm"],
        },
      });
      return res.action === "accept" && res.content?.confirm === true
        ? null
        : asJson({ confirmed: false, message: `The user did not confirm (${res.action}); no action was taken.` });
    } catch {
      // Client advertised elicitation but the request failed — fall back below.
    }
  }
  return confirm
    ? null
    : asJson({ needsConfirmation: true, message: `Do NOT proceed yet. Ask the user to confirm — about to ${summary}. Once they explicitly agree, call this tool again with confirm: true.` });
}
