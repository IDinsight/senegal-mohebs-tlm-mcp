## Deployment & hosting

### Production deployment (current state)

The server is **live on Cloud Run**: project `senegal-ci-maths`, region `europe-west1`,
service `senegal-mohebs-tlm`, capped at one instance.

- **Users connect** via a Claude custom connector pointing at
  `https://senegal-mohebs-tlm-148764688487.europe-west1.run.app/mcp`. First use runs an
  OAuth login (Supabase project `senegal-tlm-auth`, IDinsight org) on a consent page this
  server hosts at `/oauth/consent`.
- **Accounts** are created in the Supabase dashboard (Authentication → Users → *Create new
  user*, auto-confirm on). The invite-email flow is **not** supported yet — its link expects
  a password-setup page that hasn't been built.
- **A user's grade/subject selection is sticky per person** (persisted at
  `_state/<user-id>.json` in the bucket) because web clients open a fresh MCP session per
  tool call.
- **Merging to `main` does NOT deploy.** CI builds and tests only. To ship an update, from
  the repo root on `main`:

  ```bash
  gcloud run deploy senegal-mohebs-tlm --source . --region europe-west1 --project senegal-ci-maths
  ```

  Existing env vars and public-access settings are preserved. Full runbook incl. first-time
  setup, Supabase dashboard config, and post-deploy smoke checks: [`DEPLOY.md`](DEPLOY.md).

### Remote (HTTP) mode — central hosting

`npm run start:http` starts a Streamable HTTP server (for e.g. Cloud Run) instead of stdio.
Each MCP session gets its own active context and caches, so concurrent users can work on
different grades/subjects without interfering. Stdio mode (`npm start`) is unchanged.

| Env | Meaning |
|---|---|
| `PORT` | Listen port (default 8080) |
| `PUBLIC_URL` | This server's public base URL (required when auth is on) |
| `SUPABASE_URL` | `https://<ref>.supabase.co` — enables OAuth (Supabase Auth is the authorization server; this server only validates its JWTs) |
| `ALLOW_UNAUTHENTICATED` | `1` to run without auth — local testing only |

With auth on, unauthenticated calls get a 401 pointing at `/.well-known/oauth-protected-resource`,
which advertises the Supabase authorization server — MCP clients (e.g. Claude connectors)
discover the login flow from there. Every tool call is logged with the caller's identity.
`GET /healthz` is unauthenticated.

#### Per-request actor identity

Every MCP request is bound to a request-scoped `Actor` derived **only** from the
verified Supabase JWT (`sub`, `email`, `iss`) — see [`src/actor.ts`](../../src/actor.ts).
Tool handlers read the caller via `currentActor()` (nested inside the existing
`runInSession` context); tool arguments, request bodies, and client-settable
headers are never trusted for identity. Each non-GET request emits one
structured JSON audit line to stderr — `{ actor, tool, grade, subject, … }` —
as the seed for the audit store planned in a later phase.

**Defaulted decision — unknown-actor policy.** With `SUPABASE_URL` set the
bearer middleware 401s any unverified caller before we resolve an actor, so
`actor.unknown` is only reachable via `ALLOW_UNAUTHENTICATED=1` (local
testing). In that mode, unknown actors currently proceed since no roles are
enforced yet. Flip this by editing the `unknown-actor policy` block in
[`src/http.ts`](../../src/http.ts) — it is the one place to change.

### Wiring into a host (e.g. Claude Desktop)

```jsonc
{
  "mcpServers": {
    "senegal-mohebs-tlm": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "SERVICE_ACCOUNT_KEY_PATH": "/absolute/path/to/serviceAccount.json",
        "FIREBASE_STORAGE_BUCKET": "your-project.appspot.com",
        "TLM_SOURCES_DIR": "/absolute/path/to/sources",
        "TLM_GRADE": "ci",
        "TLM_SUBJECT": "maths"
      }
    }
  }
}
```

`TLM_GRADE`/`TLM_SUBJECT` are optional — omit them and the agent picks a pair with `set_context` at the start of a session.
