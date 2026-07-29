// ── Module: utils · server (leaf) ────────────────────────────────────────────
// The pure MCP-response helper and its result type. No project imports, so it's
// leaf-safe and re-exported from utils/index.ts. App-coupled tool helpers that
// need the active profile/context (guarded, badDeliverable, needsCapability) do
// NOT belong here — they live in server/shared.ts inside the server module.

// Wrap any value in the MCP text-content envelope tools must return.
export const asJson = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
export type ToolResult = ReturnType<typeof asJson>;

// ─── Shared confirmation envelope ────────────────────────────────────────────
// Two different lifecycles across the server use this envelope with
// intentionally different stakes:
//   1. GRAPH mutations (kg-store/mutations.ts) — STAGE a draft edit; publish
//      is a separate step. The framework layers `diff` + `confirmationToken`
//      on top of the fields defined here.
//   2. DOCUMENT operations (server/documents.ts) — LIVE writes to the bucket
//      / history. No draft, no diff, no publish behind them; the confirm is
//      the ONLY gate.
// The `action` field is the caller-supplied stakes-accurate phrasing; the
// `message` wraps it with the "call again with confirm: true" instruction.
// Lives in utils/ (leaf) so any module can build one without importing the
// server layer.
export type ConfirmationEnvelope = {
  needsConfirmation: true;
  action: string;
  message: string;
};
export const buildConfirmEnvelope = (action: string): ConfirmationEnvelope => ({
  needsConfirmation: true,
  action,
  message: `Do NOT proceed yet. Ask the user to confirm — about to ${action}. Once they explicitly agree, call this tool again with confirm: true.`,
});
