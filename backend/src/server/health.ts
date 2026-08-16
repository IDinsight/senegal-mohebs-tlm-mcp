/*
 * Module: server · tool group: health / liveness
 *
 * A trivial `ping` that proves the MCP TRANSPORT is up while touching NO
 * datastore. That separation is the whole point: if `ping` returns ok but the
 * data tools fail, the fault is the store/credentials (Firestore/Storage), not
 * the server; if `ping` itself is unreachable, the process/transport is down.
 * In live testing we couldn't tell those apart — this closes that gap.
 *
 * It is deliberately NOT wrapped in `guarded`: it must answer with or without an
 * active grade/subject, and it never reads the store, so there is nothing to
 * guard. Reading the active context is a pure in-memory session-bag lookup (no
 * I/O); it is wrapped defensively so ping can never itself fail.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asJson } from "./shared.js";
import { getActiveContext } from "../context/index.js";

// Process start, captured at module load — uptime is a cheap "did we just cold
// start?" signal an operator can read straight off a ping.
const startedAt = Date.now();

export function registerHealthTools(server: McpServer) {
  server.registerTool(
    "ping",
    {
      title: "Health check (no datastore)",
      description:
        "Liveness probe for the MCP transport. Returns { ok:true, ... } WITHOUT reading Firestore or Cloud Storage, so a green ping next to failing data tools isolates a store/credentials outage from a whole-server outage. Requires no context and never mutates anything.",
      inputSchema: {},
    },
    async () => {
      let activeContext: { grade: string; subject: string } | null = null;
      try {
        const ctx = getActiveContext();
        if (ctx) activeContext = { grade: ctx.grade, subject: ctx.subject };
      } catch {
        // A ping must not fail; an unreadable context just reports null.
      }
      return asJson({
        ok: true,
        status: "ok",
        transport: "up",
        activeContext,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        serverTime: new Date().toISOString(),
      });
    },
  );
}
