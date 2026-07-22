// ── Module: utils · server (leaf) ────────────────────────────────────────────
// The pure MCP-response helper and its result type. No project imports, so it's
// leaf-safe and re-exported from utils/index.ts. App-coupled tool helpers that
// need the active profile/context (guarded, badDeliverable, needsCapability) do
// NOT belong here — they live in server/shared.ts inside the server module.

// Wrap any value in the MCP text-content envelope tools must return.
export const asJson = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
export type ToolResult = ReturnType<typeof asJson>;
