/*
 * Module: utils · process safety nets (leaf)
 *
 * Installs the process-level guards that keep a single stray async failure from
 * taking down the whole server. Imports nothing from this project (Node globals
 * only), so it stays leaf-safe.
 *
 * WHY THIS EXISTS: on Node ≥15 an unhandled promise rejection terminates the
 * process by default, and an unhandled EventEmitter 'error' (e.g. a firebase
 * stream aborting) surfaces as an uncaughtException that does the same. In a
 * multi-session HTTP server that means ONE floating rejection anywhere kills
 * EVERY in-flight and future request at once — then the host restarts the
 * container (cold start), it recovers, and the next stray rejection repeats it.
 * That crash-loop is exactly the "all tools fail together, recover, fail again"
 * symptom. The MCP SDK already catches throws inside tool handlers and turns
 * them into per-request errors, so those never reach here; only truly floating
 * rejections/exceptions do — and one bad request must not be fatal to the rest.
 *
 * POLICY (chosen deliberately): log a structured line and KEEP SERVING. The
 * tradeoff is that we may continue after a genuinely corrupt state — rare for
 * this server, whose per-request state is rebuilt from the session bag and the
 * datastore on each call. Staying up beats crash-looping. Revisit if a class of
 * uncaught exception is found that genuinely corrupts shared state.
 */

let installed = false;

export function installProcessGuards(logPrefix: string): void {
  // Idempotent: both entry points (stdio + http) call this, and tests may load
  // both — installing the listeners twice would double-log every event.
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason: unknown) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`${logPrefix} unhandledRejection (logged, process kept alive):`, detail);
  });

  process.on("uncaughtException", (err: Error) => {
    // Also catches unhandled EventEmitter 'error' events (e.g. an aborted GCS
    // download stream) — the classic silent process-killer in the store path.
    console.error(`${logPrefix} uncaughtException (logged, process kept alive):`, err?.stack ?? err);
  });
}
