/*
 * Layer: app · entry point (remote)
 *
 * Streamable HTTP entry for central hosting (e.g. Cloud Run): one process, many
 * MCP sessions. Each session gets its own McpServer + SessionState, and every
 * request runs inside AsyncLocalStorage (runInSession) so the whole codebase
 * sees per-session context/caches with zero call-site plumbing. Local stdio
 * mode (index.ts) is unchanged.
 *
 * Auth: this server is an OAuth 2.1 *resource server*. Supabase Auth is the
 * authorization server — we advertise it via protected-resource metadata and
 * verify its JWTs against its JWKS. No passwords or OAuth flows live here.
 *
 * Env:
 *   PORT                   listen port (default 8080)
 *   PUBLIC_URL             this server's public base URL (required with auth)
 *   SUPABASE_URL           https://<ref>.supabase.co — enables auth
 *   SUPABASE_ANON_KEY      the project's public (anon/publishable) key — used only
 *                          by the browser-side login/consent page, safe to expose
 *   ALLOW_UNAUTHENTICATED  "1" to run without auth (local testing only)
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server/index.js";
import { listExportNamespaces, exportNamespace, exportCatalog, exportCatalogEntry, exportTerminology } from "./kg-export.js";
import { CONFIG, basePrefix, DEFAULT_WORKSPACE } from "./config.js";
import { newSessionState, runInSession, listAvailableContexts, type SessionState } from "./context/index.js";
import { readGlobalObject, writeGlobalObject } from "./storage/index.js";
import { activateContext, refreshAvailableContexts } from "./activate.js";
import { consentPage } from "./consent.js";
import { resolveActor, withMemberships, runAsActor, type Actor } from "./actor.js";
import { resolveMemberships } from "./workspaces/index.js";
import { installProcessGuards } from "./utils/index.js";

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

// ── Read-only KG export routes ───────────────────────────────────────────────
// Registered on the shared Express app. Three routes:
//   GET /kg/config      — PUBLIC. { supabaseUrl, supabaseAnonKey, authRequired }
//                         so the static page can drive its own Supabase login
//                         without baking deployment config into the HTML.
//   GET /kg/namespaces  — auth-gated. The selector list.
//   GET /kg?ns=<ns>     — auth-gated. Published display-JSON for one namespace.
//   GET /kg/catalog?ns=<ns>            — auth-gated. The catalog libraries (shared +
//                                        that workspace's) for the Catalog tab.
//   GET /kg/catalog/entry?ns=&id=      — auth-gated. One entry's full spec (markdown).
//   GET /kg/terminology?ns=<ns>        — auth-gated. The workspace's bilingual lexicon
//                                        (FR/Wolof glossary) for the Terminology tab.
// CORS is allow-listed to the hosting origin(s); auth requires a valid Supabase
// Bearer JWT whenever auth is enabled (mirrors /mcp). All read-only, published-only.
//
// KG_EXPLORER_PUBLIC=1 opens the read-only explorer to anyone (no Supabase
// login): it ungates the /kg read routes and reports authRequired:false so the
// static page skips its login gate. This affects ONLY the /kg read surface — the
// /mcp authoring endpoint stays JWT-gated regardless. Default (unset) keeps the
// explorer gated. NOTE: making it public exposes every seeded namespace's
// published graph to anyone with the URL (CORS does not restrict non-browser
// clients), so set it only when public read access is intended.
function registerKgRoutes(app: express.Express, authEnabled: boolean, verifier: OAuthTokenVerifier | null): void {
  const explorerPublic = process.env.KG_EXPLORER_PUBLIC === "1";
  const allowed = (process.env.KG_ALLOWED_ORIGINS
    ?? "https://senegal-ci-maths.web.app,https://senegal-ci-maths.firebaseapp.com")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const isLocalhost = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

  // CORS: echo the origin only when it is allow-listed (or localhost for dev).
  const cors: express.RequestHandler = (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowed.includes(origin) || isLocalhost(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
      res.setHeader("Access-Control-Max-Age", "3600");
    }
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  };

  // Auth: require a verifiable Supabase Bearer JWT when auth is on. In
  // ALLOW_UNAUTHENTICATED mode (local only) or when the explorer is public it is
  // a pass-through.
  const requireJwt: express.RequestHandler = async (req, res, next) => {
    if (!authEnabled || explorerPublic) return next();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m) { res.status(401).json({ error: "missing_bearer_token" }); return; }
    try { await verifier!.verifyAccessToken(m[1]); next(); }
    catch { res.status(401).json({ error: "invalid_token" }); }
  };

  app.options(/^\/kg(\/.*)?$/, cors);

  app.get("/kg/config", cors, (_req, res) => {
    res.json({
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
      authRequired: authEnabled && !explorerPublic,
    });
  });

  app.get("/kg/namespaces", cors, requireJwt, async (_req, res) => {
    try {
      res.json({ namespaces: await listExportNamespaces() });
    } catch (e) {
      console.error(`${LOG} /kg/namespaces failed:`, (e as Error).message);
      res.status(500).json({ error: "export_failed", message: (e as Error).message });
    }
  });

  app.get("/kg", cors, requireJwt, async (req, res) => {
    const ns = String(req.query.ns ?? "").trim();
    if (!ns) { res.status(400).json({ error: "missing_ns" }); return; }
    try {
      const graph = await exportNamespace(ns);
      if (!graph) { res.status(404).json({ error: "unknown_or_unseeded_namespace", ns }); return; }
      res.json(graph);
    } catch (e) {
      console.error(`${LOG} /kg?ns=${ns} failed:`, (e as Error).message);
      res.status(500).json({ error: "export_failed", message: (e as Error).message });
    }
  });

  // The Catalog tab: the reusable-spec libraries (routines + formatters) a curator of
  // this namespace's workspace can browse — the shared library plus the workspace's own.
  app.get("/kg/catalog", cors, requireJwt, async (req, res) => {
    const ns = String(req.query.ns ?? "").trim();
    if (!ns) { res.status(400).json({ error: "missing_ns" }); return; }
    try {
      const catalog = await exportCatalog(ns);
      if (!catalog) { res.status(404).json({ error: "not_a_curriculum_namespace", ns }); return; }
      res.json(catalog);
    } catch (e) {
      console.error(`${LOG} /kg/catalog?ns=${ns} failed:`, (e as Error).message);
      res.status(500).json({ error: "export_failed", message: (e as Error).message });
    }
  });

  // One catalog entry's full authored spec as markdown — the Catalog tab's click-through.
  app.get("/kg/catalog/entry", cors, requireJwt, async (req, res) => {
    const ns = String(req.query.ns ?? "").trim();
    const id = String(req.query.id ?? "").trim();
    if (!ns || !id) { res.status(400).json({ error: "missing_ns_or_id" }); return; }
    try {
      const markdown = await exportCatalogEntry(ns, id);
      if (markdown == null) { res.status(404).json({ error: "unknown_catalog_entry", ns, id }); return; }
      res.json({ id, markdown });
    } catch (e) {
      console.error(`${LOG} /kg/catalog/entry?ns=${ns}&id=${id} failed:`, (e as Error).message);
      res.status(500).json({ error: "export_failed", message: (e as Error).message });
    }
  });

  // The Terminology tab: the workspace's bilingual lexicon (the FR/Wolof glossary the
  // translate + get_terminology tools ground on), keyed by this namespace's workspace.
  app.get("/kg/terminology", cors, requireJwt, async (req, res) => {
    const ns = String(req.query.ns ?? "").trim();
    if (!ns) { res.status(400).json({ error: "missing_ns" }); return; }
    try {
      const terminology = await exportTerminology(ns);
      if (!terminology) { res.status(404).json({ error: "not_a_curriculum_namespace", ns }); return; }
      res.json(terminology);
    } catch (e) {
      console.error(`${LOG} /kg/terminology?ns=${ns} failed:`, (e as Error).message);
      res.status(500).json({ error: "export_failed", message: (e as Error).message });
    }
  });
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
    // `workspace` is new; a legacy 2-field state (pre-workspaces) defaults to
    // the single tenant everything used to live in.
    const { workspace, grade, subject } = JSON.parse(raw);
    const ws = workspace || DEFAULT_WORKSPACE;
    if (grade && subject) {
      const r = await activateContext(ws, grade, subject);
      if (!r.ok) console.error(`${LOG} could not restore ${sub}'s context ${ws}/${grade}/${subject}: ${r.error}`);
    }
  } catch (e) { console.error(`${LOG} context restore failed for ${sub}:`, (e as Error).message); }
}

function persistUserContext(sub: string, state: SessionState): void {
  const a = state.active;
  if (!a) return;
  writeGlobalObject(userStateKey(sub), JSON.stringify({ workspace: a.workspace, grade: a.grade, subject: a.subject }))
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
    const ws = CONFIG.defaultWorkspace || DEFAULT_WORKSPACE;
    readyPromise = runInSession(state, async () => {
      const r = await activateContext(ws, CONFIG.defaultGrade, CONFIG.defaultSubject);
      if (!r.ok) console.error(`${LOG} startup context not activated: ${r.error}`);
    });
  }
  // Connect inside the session so any context-touching init sees session state.
  // Attach a .catch: an un-awaited connect that rejected would be an unhandled
  // rejection — and this runs on EVERY new session (claude.ai opens one per
  // call), so a floating rejection here was a prime crash-loop trigger.
  runInSession(state, () => server.connect(transport)).catch((e) =>
    console.error(`${LOG} session connect failed:`, (e as Error).message));
  return { transport, state, restoreTried: false, ready: readyPromise };
}

async function main() {
  // Install BEFORE any request can arrive: a single stray unhandled rejection or
  // uncaught exception (e.g. an aborted GCS stream) would otherwise kill the
  // whole process and take EVERY session down at once — the crash-loop we saw.
  installProcessGuards(LOG);

  // Discover installed contexts from the store once at boot (the context list is
  // process-global, not per-session). Best-effort: on a store error the list
  // stays empty and the first tool call re-prompts. Log what was discovered so an
  // operator can confirm, from the startup logs, which namespaces the store holds.
  try {
    await refreshAvailableContexts();
    const found = listAvailableContexts();
    console.error(`${LOG} discovered ${found.length} context(s) from the store: ${found.map((c) => `${c.workspace}/${c.grade}/${c.subject}`).join(", ") || "(none)"}`);
  } catch (e) {
    console.error(`${LOG} could not list namespaces from the store:`, (e as Error).message);
  }

  const app = express();
  app.use(express.json({ limit: "8mb" }));

  // Health check. `/health` is the externally-reachable one: Google's Front End
  // reserves the literal path `/healthz` and 404s it before it reaches the
  // container (every neighbouring path — `/health`, `/healthz/` — passes through
  // fine), so an external smoke check / uptime monitor must hit `/health`.
  // `/healthz` stays for a container-internal HTTP probe, which bypasses GFE.
  const health = (_req: express.Request, res: express.Response) => { res.status(200).send("ok"); };
  app.get("/health", health);
  app.get("/healthz", health);

  const authEnabled = !!SUPABASE_URL;
  // One verifier instance, shared by /mcp's bearer middleware and the read-only
  // /kg endpoint (below). Building it creates a cached remote JWKS, so reusing
  // one instance avoids a second JWKS fetcher.
  const verifier = authEnabled ? supabaseVerifier() : null;
  if (!authEnabled && process.env.ALLOW_UNAUTHENTICATED !== "1") {
    console.error(`${LOG} refusing to start: SUPABASE_URL is not set. Set it, or set ALLOW_UNAUTHENTICATED=1 for local testing.`);
    process.exit(1);
  }

  // ── Read-only KG export (companion to the MCP server) ──────────────────────
  // Serves the live explorer: GET /kg/namespaces (selector) and GET /kg?ns=…
  // (published display-JSON). Purely additive; the MCP tools/auth are untouched.
  // CORS is allow-listed to the Firebase Hosting origin(s) (override with
  // KG_ALLOWED_ORIGINS, comma-separated) plus localhost for local dev. Auth: a
  // valid Supabase Bearer JWT is required whenever auth is enabled — the same
  // trust channel as /mcp — so the endpoint honours the same access model.
  registerKgRoutes(app, authEnabled, verifier);

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
    app.use("/mcp", requireBearerAuth({ verifier: verifier!, resourceMetadataUrl }));

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
      } else if (sessionId) {
        // A session id was sent but we don't hold it — the server restarted (a deploy
        // drops all in-memory sessions) or the session expired. Per the MCP spec this
        // is a 404, NOT a 400: 404 tells the client to start a NEW session by
        // re-initializing. It reconnects transparently, and restoreUserContext() then
        // reloads this user's grade/subject from the bucket — so a redeploy needs NO
        // manual reconnect. Returning 400 here made clients treat it as a hard error
        // and stall (the "set_context rejected" symptom after a deploy).
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found or expired — start a new session by re-initializing." }, id: (req.body && req.body.id) ?? null });
        return;
      } else {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session. Send an initialize request first." }, id: null });
        return;
      }
    }

    // Resolve the caller's identity from the verified auth layer ONLY. Never
    // from tool arguments, request body, or client-settable headers — those
    // are spoofable. `resolveActor` is the single writer for actor state.
    let actor: Actor = resolveActor((req as any).auth);
    // Attach per-workspace memberships (the authoritative authz source) with ONE
    // registry read per request. Identity stays sync + spoof-proof; only this
    // app-layer step touches the store. Fail-closed: a read error leaves
    // memberships empty (super-admin, from env, still stands).
    if (!actor.unknown) {
      try {
        actor = withMemberships(actor, await resolveMemberships(actor.id));
      } catch (e) {
        console.error(`${LOG} membership read failed for ${actor.id}:`, (e as Error).message);
      }
    }

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
      }));
    }
  });

  app.listen(PORT, () => {
    console.error(`${LOG} listening on :${PORT} (${sessions.size} sessions, assets: ${CONFIG.assetsDir})`);
  });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
