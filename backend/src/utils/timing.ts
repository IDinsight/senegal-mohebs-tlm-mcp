/*
 * Layer: core (leaf)
 *
 * Opt-in phase timing, gated on TLM_TIMING. Off by default, so a production
 * process pays only a single env read per call and logs nothing. Turn it on
 * (TLM_TIMING=1) to trace where a slow graph mutation spends its wall-clock —
 * the whole-graph Firestore rewrite vs the draft copy vs reads vs hashing.
 *
 * Everything writes to STDERR, never stdout: the stdio MCP transport speaks
 * JSON-RPC on stdout, so a stray log line there would corrupt the protocol.
 */

// Read lazily (not memoised) so a test or a script can flip it mid-process.
const on = (): boolean => process.env.TLM_TIMING === "1" || process.env.TLM_TIMING === "true";

// Time an async phase. When timing is off this is a thin pass-through — the
// awaited function runs exactly as it would without the wrapper.
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!on()) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    console.error(`[timing] ${label}: ${Math.round(performance.now() - started)}ms`);
  }
}

// Time a synchronous phase (e.g. hashGraph, the in-memory apply fold).
export function timedSync<T>(label: string, fn: () => T): T {
  if (!on()) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    console.error(`[timing] ${label}: ${Math.round(performance.now() - started)}ms`);
  }
}

// Emit a one-off detail line under the current phase (e.g. "committed N chunks").
// No-op unless timing is on, so call sites stay free of their own env checks.
export function note(label: string, detail: string): void {
  if (on()) console.error(`[timing] ${label}: ${detail}`);
}
