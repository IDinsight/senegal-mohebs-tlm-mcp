/*
 * Process safety-net tests (issue #1 — the crash-loop)
 *
 * The crash-loop was: a single unhandled rejection / uncaught exception (Node's
 * default is to TERMINATE the process) took the whole multi-session server down,
 * the host cold-restarted it, it recovered, and the next stray failure repeated
 * it. installProcessGuards must register handlers for BOTH fatal events and make
 * them log-and-continue, so one bad async failure can no longer be fatal.
 *
 * We invoke the registered handlers DIRECTLY (rather than emitting the real
 * process events, which would also trip vitest's own listeners) to prove they
 * swallow the failure without throwing — i.e. the process would stay up.
 */
import { describe, it, expect, vi } from "vitest";
import { installProcessGuards } from "./process.js";

describe("installProcessGuards", () => {
  it("registers unhandledRejection + uncaughtException handlers that never rethrow", () => {
    const beforeR = process.listeners("unhandledRejection").length;
    const beforeE = process.listeners("uncaughtException").length;

    installProcessGuards("[test]");

    expect(process.listeners("unhandledRejection").length).toBe(beforeR + 1);
    expect(process.listeners("uncaughtException").length).toBe(beforeE + 1);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const onRejection = process.listeners("unhandledRejection").at(-1) as (r: unknown, p?: unknown) => void;
      const onException = process.listeners("uncaughtException").at(-1) as (e: Error) => void;

      // Neither handler may rethrow — that is what keeps the process alive.
      expect(() => onRejection(new Error("stray rejection"), Promise.resolve())).not.toThrow();
      expect(() => onException(new Error("aborted GCS stream"))).not.toThrow();

      // And each logs a structured line so the failure is not silent.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("unhandledRejection"))).toBe(true);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("uncaughtException"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("is idempotent — a second call adds no duplicate listeners", () => {
    const r = process.listeners("unhandledRejection").length;
    const e = process.listeners("uncaughtException").length;
    installProcessGuards("[test]");
    installProcessGuards("[test]");
    expect(process.listeners("unhandledRejection").length).toBe(r);
    expect(process.listeners("uncaughtException").length).toBe(e);
  });
});
