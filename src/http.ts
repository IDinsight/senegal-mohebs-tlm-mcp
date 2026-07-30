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
//   SUPABASE_ANON_KEY      the project's public (anon/publishable) key — used only
//                          by the browser-side login/consent page, safe to expose
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
import { CONFIG, basePrefix, kgSource } from "./config.js";
import { newSessionState, runInSession, type SessionState } from "./context/index.js";
import { readGlobalObject, writeGlobalObject } from "./storage/index.js";
import { activateContext } from "./activate.js";
import { consentPage } from "./consent.js";
import { resolveActor, runAsActor, type Actor } from "./actor.js";

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
          // `iss` is captured so the actor layer can record the verified issuer
          // — jwtVerify already asserted it matches `issuer`, so it is safe to trust.
          // `app_role` is the authorization claim added by the Custom Access Token
          // Hook (see scripts/supabase-user-roles.sql) — it's part of the same
          // signature-verified payload as sub/email/iss, so authz shares identity's
          // trust channel and cannot be spoofed by a header or tool argument.
          extra: { sub: payload.sub, email: (payload as any).email, iss: payload.iss, app_role: (payload as any).app_role },
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
type Session = { transport: StreamableHTTPServerTransport; state: SessionState; restoreTried: boolean; ready: Promise<void> };
const sessions = new Map<string, Session>();

// ── Per-USER context persistence ─────────────────────────────────────────────
// Web clients (claude.ai) open a fresh MCP session for every tool call, so
// per-session context alone evaporates between calls. The user's grade/subject
// selection is therefore persisted per identity (JWT sub) in the bucket and
// lazily restored into any new session that arrives without one. set_context
// is thus sticky per person, across sessions and server restarts.
const userStateKey = (sub: string) => `${basePrefix()}_state/${sub}.json`;

async function restoreUserContext(sub: string): Promise<void> {
  try {
    const raw = await readGlobalObject(userStateKey(sub));
    if (!raw) return;
    const { grade, subject } = JSON.parse(raw);
    if (grade && subject) {
      const r = await activateContext(grade, subject);
      if (!r.ok) console.error(`${LOG} could not restore ${sub}'s context ${grade}/${subject}: ${r.error}`);
    }
  } catch (e) { console.error(`${LOG} context restore failed for ${sub}:`, (e as Error).message); }
}

function persistUserContext(sub: string, state: SessionState): void {
  const a = state.active;
  if (!a) return;
  writeGlobalObject(userStateKey(sub), JSON.stringify({ grade: a.grade, subject: a.subject }))
    .catch((e) => console.error(`${LOG} context persist failed for ${sub}:`, (e as Error).message));
}

function newSession(): Session {
  const state = newSessionState();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: (id) => { sessions.set(id, { transport, state, restoreTried: false, ready: readyPromise }); },
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  const server = buildServer();
  // Optional startup context (TLM_GRADE/TLM_SUBJECT) applies per session, same
  // semantics as stdio startup. activateContext is async now (Firestore mode
  // hydrates over the network), so first-request dispatch awaits `ready`
  // before touching handlers — otherwise the very first tool call could race
  // against startup activation and see `active === null`.
  let readyPromise: Promise<void> = Promise.resolve();
  if (CONFIG.defaultGrade && CONFIG.defaultSubject) {
    readyPromise = runInSession(state, async () => {
      const r = await activateContext(CONFIG.defaultGrade, CONFIG.defaultSubject);
      if (!r.ok) console.error(`${LOG} startup context not activated: ${r.error}`);
    });
  }
  // Connect inside the session so any context-touching init sees session state.
  void runInSession(state, () => server.connect(transport));
  return { transport, state, restoreTried: false, ready: readyPromise };
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

    // Supabase's OAuth server delegates the login/consent UI to the application
    // (dashboard: Site URL = this service, Authorization Path = /oauth/consent).
    // Served here so no separate frontend deployment is needed. Public by design:
    // the user is mid-login. Needs the public anon key for browser-side supabase-js.
    const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
    if (anonKey) {
      const page = consentPage(SUPABASE_URL, anonKey);
      app.get("/oauth/consent", (_req, res) => { res.type("html").send(page); });
    } else {
      console.error(`${LOG} WARNING: SUPABASE_ANON_KEY not set — /oauth/consent disabled; OAuth logins cannot complete.`);
    }
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

    // Resolve the caller's identity from the verified auth layer ONLY. Never
    // from tool arguments, request body, or client-settable headers — those
    // are spoofable. `resolveActor` is the single writer for actor state.
    const actor: Actor = resolveActor((req as any).auth);

    // ── unknown-actor policy (DEFAULTED — flip here when roles land) ─────────
    // Today: unknown actors proceed (no roles are enforced anywhere yet).
    // With `SUPABASE_URL` set, the bearer middleware already 401s before we
    // get here, so `actor.unknown` is only reachable via ALLOW_UNAUTHENTICATED=1
    // (local testing). To require identity for every /mcp call, replace this
    // block with e.g. `if (actor.unknown) { res.status(401).json(...); return; }`.
    const method = req.method === "POST" ? req.body?.method : req.method;
    const toolName = req.method === "POST" && req.body?.method === "tools/call"
      ? (req.body?.params?.name as string | undefined) : undefined;

    // Persistence keys off the verified actor id (or "unknown" in unauth mode).
    const sub = actor.id;
    const s = session;
    // Wait for any startup activation to finish before dispatching. In bundle
    // mode this is a resolved promise; in Firestore mode it covers the initial
    // network round-trip so the first tool call sees a populated context.
    await s.ready;
    const activeBefore = s.state.active;
    await runAsActor(actor, async () => {
      await runInSession(s.state, async () => {
        // New session with no context: restore this user's last selection first,
        // so tool calls on fresh sessions (claude.ai opens one per call) work.
        // Skip restore for unknown actors — no persisted state to restore against.
        if (!s.state.active && !s.restoreTried && !actor.unknown) {
          s.restoreTried = true;
          await restoreUserContext(sub);
        }
        await s.transport.handleRequest(req, res, req.body);
      });
    });
    if (s.state.active !== activeBefore && !actor.unknown) persistUserContext(sub, s.state);

    // One structured log line per non-GET JSON-RPC request. Complements #7's
    // durable audit store — this line is ephemeral operational logging (who
    // called what, when, against which backend) and stays in stderr; the
    // per-graph-op audit records live in the `kg_audit` Firestore collection
    // and are queryable via KgNodeStore.listAudit. When #11 lands the first
    // real graph edit tool, we plan to also emit the resulting audit-record
    // ids in the tool's response and mirror them here for one-line tracing.
    if (method && method !== "GET") {
      const a = s.state.active;
      console.error(`${LOG} ` + JSON.stringify({
        msg: "tool_call",
        actor: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        unknown: actor.unknown || undefined,
        method,
        tool: toolName,
        grade: a?.grade ?? null,
        subject: a?.subject ?? null,
        // Which backend served curriculum/KG reads for this call. Sourced
        // from the config flag, not any client-controlled input — so the
        // audit log records the actual data path, not a claimed one.
        kgSource: kgSource(),
      }));
    }
  });

  app.listen(PORT, () => {
    console.error(`${LOG} listening on :${PORT} (${sessions.size} sessions, sources: ${CONFIG.sourcesDir})`);
  });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
