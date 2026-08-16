/*
 * Module: utils · server (leaf)
 *
 * The pure MCP-response helper and its result type. No project imports, so it's
 * leaf-safe and re-exported from utils/index.ts. App-coupled tool helpers that
 * need the active profile/context (guarded, needsCapability) do NOT belong here
 * — they live in server/shared.ts inside the server module.
 */

// Wrap any value in the MCP text-content envelope tools must return.
export const asJson = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
// A tool result is the text envelope, optionally flagged `isError` (the typed
// error path below uses it). Declared explicitly — not `ReturnType<typeof
// asJson>` — so the error envelope is assignable to the same handler type.
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// ─── Structured, typed tool errors ───────────────────────────────────────────
// The MCP SDK turns any throw inside a handler into a bare `error.message` tool
// error with no structure — which is why a store outage, a bad argument, and a
// stale token all looked identical ("Tool execution failed") in live testing.
// These helpers replace that with a stable `{ error: { code, message } }`
// envelope (isError set) so callers can branch on `code`. Lives in utils/
// (leaf) so any layer can throw a CodedError without importing the server.
export type ToolErrorCode =
  | "VALIDATION_ERROR"   // bad arguments (the SDK also emits its own before the handler runs)
  | "STORE_UNAVAILABLE"  // Firestore / Cloud Storage / network / credentials — the datastore path
  | "STALE_TOKEN"        // two-phase confirm: state moved since preview (re-review)
  | "TOKEN_EXPIRED"      // two-phase confirm: token past its TTL (re-run the dry-run)
  | "NOT_FOUND"          // a named resource does not exist
  | "INTERNAL_ERROR";    // anything not otherwise classified

// A throwable carrying a stable code, so any layer can signal a typed failure
// that `guarded` surfaces verbatim instead of re-classifying by message.
export class CodedError extends Error {
  readonly code: ToolErrorCode;
  readonly detail?: unknown;
  constructor(code: ToolErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "CodedError";
    this.code = code;
    this.detail = detail;
  }
}

// Debug mode surfaces stacks in the error envelope. Off by default so prod
// clients never see internals; flip TLM_DEBUG=1 (or NODE_ENV=development) when
// diagnosing.
export const isDebug = (): boolean => process.env.TLM_DEBUG === "1" || process.env.NODE_ENV === "development";

// Best-effort classification of an unknown thrown value into a stable code.
// CodedError wins outright; otherwise we recognise the store/transport failure
// shapes the firebase-admin / google-cloud libs throw (error codes + common
// phrases) so a datastore outage is distinguishable from a logic bug — the
// exact distinction that was impossible with the old generic string.
export function classifyError(e: unknown): { code: ToolErrorCode; message: string } {
  if (e instanceof CodedError) return { code: e.code, message: e.message };
  const message = e instanceof Error ? e.message : String(e);
  if (/\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN)\b|socket hang up|network error|Could not (load|refresh) default credentials|credential|GaxiosError|firebase|storage bucket|\bbucket\b|Quota exceeded|rate limit|DEADLINE_EXCEEDED|UNAVAILABLE/i.test(message)) {
    return { code: "STORE_UNAVAILABLE", message };
  }
  return { code: "INTERNAL_ERROR", message };
}

// Build the MCP error envelope: structured `{ error: { code, message, detail? } }`
// with `isError` set. `detail` is included only when passed (guarded adds a
// stack here in debug mode).
export function toolError(code: ToolErrorCode, message: string, detail?: unknown): ToolResult {
  const error: Record<string, unknown> = { code, message };
  if (detail !== undefined) error.detail = detail;
  return {
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
    isError: true,
  };
}

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
