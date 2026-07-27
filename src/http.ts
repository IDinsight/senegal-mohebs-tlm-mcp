// ── Layer: app · entry point (remote) ────────────────────────────────────────
// Streamable HTTP entry for central hosting (e.g. Cloud Run): one process, many
// MCP sessions. Each session gets its own McpServer + SessionState, and every
// request runs inside AsyncLocalStorage (runInSession) so the whole codebase
// sees per-session context/caches with zero call-site plumbing. Local stdio
// mode (index.ts) is unchanged.
//
// Auth: this server is an OAuth 2.1 *resource server*. Supabase Auth is the
// authorization server — we advertise it via protected-resource metadata and
// verify its JWTs against its JWKS. No passwords or OAuth flows live here.
//
// Env:
//   PORT                   listen port (default 8080)
//   PUBLIC_URL             this server's public base URL (required with auth)
//   SUPABASE_URL           https://<ref>.supabase.co — enables auth
//   ALLOW_UNAUTHENTICATED  "1" to run without auth (local testing only)
import { randomUUID } from "node:crypto";
import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server/index.js";
import { CONFIG } from "./config.js";
import { newSessionState, runInSession, type SessionState } from "./context/index.js";
import { activateContext } from "./activate.js";

const LOG = "[senegal-mohebs-tlm:http]";
const PORT = parseInt(process.env.PORT ?? "8080", 10);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");

// ── Auth: verify Supabase-issued JWTs (resource-server side) ─────────────────
function supabaseVerifier(): OAuthTokenVerifier {
  const issuer = `${SUPABASE_URL}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer, audience: "authenticated" });
        return {
          token,
          clientId: (payload as any).client_id ?? "unknown",
          scopes: [],
          expiresAt: payload.exp,
          extra: { sub: payload.sub, email: (payload as any).email },
        };
      } catch (e) {
        // Map every verification failure (bad signature, expiry, JWKS fetch) to
        // a 401 InvalidTokenError so clients re-authenticate instead of seeing 500s.
        throw new InvalidTokenError((e as Error).message);
      }
    },
  };
}

// ── Sessions: one transport + server + state per MCP session ─────────────────
type Session = { transport: StreamableHTTPServerTransport; state: SessionState };
const sessions = new Map<string, Session>();

function newSession(): Session {
  const state = newSessionState();
  // Optional startup context (TLM_GRADE/TLM_SUBJECT) applies per session, same
  // semantics as stdio startup. Startup reconcile is skipped here — it's
  // informational logging, and per-session bucket sweeps would be noise.
  if (CONFIG.defaultGrade && CONFIG.defaultSubject) {
    runInSession(state, () => {
      const r = activateContext(CONFIG.defaultGrade, CONFIG.defaultSubject);
      if (!r.ok) console.error(`${LOG} startup context not activated: ${r.error}`);
    });
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: (id) => { sessions.set(id, { transport, state }); },
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  const server = buildServer();
  // Connect inside the session so any context-touching init sees session state.
  void runInSession(state, () => server.connect(transport));
  return { transport, state };
}

async function main() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/healthz", (_req, res) => { res.status(200).send("ok"); });

  const authEnabled = !!SUPABASE_URL;
  if (!authEnabled && process.env.ALLOW_UNAUTHENTICATED !== "1") {
    console.error(`${LOG} refusing to start: SUPABASE_URL is not set. Set it, or set ALLOW_UNAUTHENTICATED=1 for local testing.`);
    process.exit(1);
  }

  if (authEnabled) {
    if (!PUBLIC_URL) { console.error(`${LOG} PUBLIC_URL is required when auth is enabled.`); process.exit(1); }
    const resourceMetadataUrl = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;
    // Protected-resource metadata (RFC 9728): tells MCP clients where to log in.
    app.get("/.well-known/oauth-protected-resource", (_req, res) => {
      res.json({
        resource: PUBLIC_URL,
        authorization_servers: [`${SUPABASE_URL}/auth/v1`],
        bearer_methods_supported: ["header"],
      });
    });
    app.use("/mcp", requireBearerAuth({ verifier: supabaseVerifier(), resourceMetadataUrl }));
    console.error(`${LOG} auth enabled — authorization server: ${SUPABASE_URL}/auth/v1`);
  } else {
    console.error(`${LOG} WARNING: running UNAUTHENTICATED (ALLOW_UNAUTHENTICATED=1) — local testing only.`);
  }

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      if (req.method === "POST" && isInitializeRequest(req.body)) {
        session = newSession();
      } else {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session. Send an initialize request first." }, id: null });
        return;
      }
    }

    // Per-user audit line: who (Supabase identity) did what (JSON-RPC method/tool).
    const who = (req as any).auth?.extra;
    const method = req.method === "POST" ? req.body?.method : req.method;
    const tool = req.method === "POST" && req.body?.method === "tools/call" ? ` ${req.body?.params?.name}` : "";
    if (method && method !== "GET") console.error(`${LOG} ${who?.email ?? who?.sub ?? "anon"} → ${method}${tool}`);

    const s = session;
    await runInSession(s.state, () => s.transport.handleRequest(req, res, req.body));
  });

  app.listen(PORT, () => {
    console.error(`${LOG} listening on :${PORT} (${sessions.size} sessions, sources: ${CONFIG.sourcesDir})`);
  });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
