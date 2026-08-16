/*
 * Module: server · internal helpers
 *
 * Tool helpers that depend on app-layer state (the active adapter / context),
 * so they live inside the server module rather than in utils (which stays a
 * leaf). The pure asJson primitive comes from the utils barrel and is
 * re-exported here so each tool group imports all its helpers from one place
 * ("./shared.js").
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asJson, buildConfirmEnvelope, classifyError, toolError, isDebug, type ToolResult } from "../utils/index.js";
import { ContextNotSetError } from "../context/index.js";

export { asJson, toolError, type ToolResult };

const LOG = "[senegal-mohebs-tlm]";

// Wrap a tool handler so that:
//   • no grade/subject active → a friendly `needsContext` prompt (not an error);
//   • any other throw → a STRUCTURED, typed `{ error: { code, message } }`
//     envelope with `isError` set, instead of the SDK's bare `error.message`.
// The typed code (STORE_UNAVAILABLE vs INTERNAL_ERROR vs …) is what lets a
// caller tell a datastore outage apart from a logic bug — the distinction that
// was impossible when every failure read "Tool execution failed". The real
// message is always included; a stack is added only in debug mode (TLM_DEBUG=1).
// (Argument-validation failures are caught by the SDK BEFORE the handler runs,
// so they surface as the SDK's own "Input validation error: …" — already
// distinct from the handler-side codes below.)
// Every source- or bucket-dependent tool is registered through this.
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
    const { code, message } = classifyError(e);
    // One structured stderr line so an operator can correlate the client-facing
    // typed error with the server log (and see the stack there even in prod).
    console.error(`${LOG} tool handler error [${code}]:`, e instanceof Error ? (e.stack ?? e.message) : String(e));
    const detail = isDebug() && e instanceof Error ? { stack: e.stack } : undefined;
    return toolError(code, message, detail);
  }
};

// Guard a capability-specific tool: returns an explanatory ToolResult when the
// active subject's adapter doesn't enable the capability, else null so the
// tool runs. Keeps capability-only tools from returning misleading empty data
// for subjects they don't apply to.
export const needsCapability = (enabled: boolean, cap: string): ToolResult | null =>
  enabled ? null : asJson({ notApplicable: true, message: `Not applicable for the active subject: this tool requires the '${cap}' capability, which this subject's adapter does not enable.` });

// Human confirmation for outward-facing / state-changing tools (file uploads,
// history writes, and the graph-mutation framework). Returns a ToolResult (→
// caller does NO side effect) unless the user has approved, in which case it
// returns null (→ proceed). "Best available" gate across clients:
//   • Client supports MCP elicitation → ask the USER directly via a dialog. This
//     is the strong gate — the agent cannot bypass it with confirm:true.
//   • Otherwise → fall back to the agent-mediated two-step: no side effect until
//     the tool is re-called with confirm:true (the agent is told to ask first).
export async function requireConfirmation(server: McpServer, confirm: boolean | undefined, action: string): Promise<ToolResult | null> {
  const caps = server.server.getClientCapabilities();
  if (caps?.elicitation) {
    try {
      const res = await server.server.elicitInput({
        message: `Confirm before proceeding — about to ${action}. Proceed?`,
        requestedSchema: {
          type: "object",
          properties: { confirm: { type: "boolean", title: "Proceed?", description: `Approve: ${action}` } },
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
  return confirm ? null : asJson(buildConfirmEnvelope(action));
}
