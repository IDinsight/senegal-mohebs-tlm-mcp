# Deploying to Cloud Run

The server runs as a remote MCP server (Streamable HTTP, `dist/http.js`) on Cloud Run in the
`senegal-ci-maths` GCP project. Supabase Auth is the OAuth authorization server; this service
only validates its JWTs. Users connect via Claude custom connectors pointing at `PUBLIC_URL/mcp`.

## One-time setup

```bash
gcloud config set project senegal-ci-maths

# Dedicated least-privilege runtime service account
gcloud iam service-accounts create tlm-server --display-name "MOHEBS TLM MCP server"

# Bucket access + signed-URL signing (no JSON keys anywhere)
gcloud storage buckets add-iam-policy-binding gs://senegal-ci-maths.firebasestorage.app \
  --member "serviceAccount:tlm-server@senegal-ci-maths.iam.gserviceaccount.com" \
  --role roles/storage.objectAdmin
gcloud iam service-accounts add-iam-policy-binding \
  tlm-server@senegal-ci-maths.iam.gserviceaccount.com \
  --member "serviceAccount:tlm-server@senegal-ci-maths.iam.gserviceaccount.com" \
  --role roles/iam.serviceAccountTokenCreator
```

## Deploy (from repo root)

The server package (with its `Dockerfile`) lives under `backend/`, so the build source
is that directory rather than the repo root.

```bash
gcloud run deploy senegal-mohebs-tlm \
  --source backend \
  --project senegal-ci-maths \
  --region europe-west1 \
  --service-account tlm-server@senegal-ci-maths.iam.gserviceaccount.com \
  --max-instances 1 \
  --allow-unauthenticated \
  --set-env-vars "FIREBASE_STORAGE_BUCKET=senegal-ci-maths.firebasestorage.app,SUPABASE_URL=https://<ref>.supabase.co,SUPABASE_ANON_KEY=<public anon key>,PUBLIC_URL=https://<service-url>"
```

Notes:

- `--allow-unauthenticated` refers to the **GCP IAM layer** only — app-level auth is enforced
  by the server itself (Supabase JWTs; it refuses to start without `SUPABASE_URL` unless
  `ALLOW_UNAUTHENTICATED=1`, which must never be set in production).
- `--max-instances 1` is required for now: MCP session state is held in memory, so requests
  must land on one instance. Fine at this scale; revisit with sticky sessions if usage grows.
- **First deploy chicken-and-egg:** `PUBLIC_URL` must equal the service URL, which you only
  know after the first deploy. Deploy once, read the URL, then update the env var
  (`gcloud run services update senegal-mohebs-tlm --update-env-vars PUBLIC_URL=...`).
- No `SERVICE_ACCOUNT_KEY_PATH` on Cloud Run — the runtime service account provides
  Application Default Credentials; signed URLs sign via the IAM credentials API
  (hence the TokenCreator role above).
- The KG lives in **Firestore, not the image**, so adding or updating a graph needs **no redeploy** —
  use `import:kg-store` (see [`docs/technical-reference/store.md`](docs/technical-reference/store.md)).
  A *new subject* still needs a redeploy, because its profile is code (registered under
  `backend/src/adapters/profiles/`). The per-subject `backend/assets/` (terminology, prompt files) ship in the
  image, so changing those needs a redeploy too.

## Supabase dashboard configuration

The server hosts Supabase's delegated login/consent UI at `/oauth/consent` (hence
`SUPABASE_ANON_KEY`, the public browser key from Project Settings → API). Configure:

- **Authentication → OAuth Server**: enabled, **Dynamic OAuth Apps** on,
  **Authorization Path** = `/oauth/consent`.
- **Authentication → URL Configuration**: **Site URL** = `https://<service-url>`
  (the TLM service — it serves the consent page for both MCP servers).
- **Authentication → Users**: invite designers by email (they set a password via the invite link).

## Claude connector

Point a Claude custom connector at `https://<service-url>/mcp`. The 401 challenge advertises
`/.well-known/oauth-protected-resource`, which points at the Supabase authorization server —
the client discovers the login flow from there, registers itself dynamically, and sends the
user to the consent page above.

## Smoke checks after deploy

```bash
curl -s https://<service-url>/health                                   # → ok  (NOT /healthz — see note)
curl -s https://<service-url>/.well-known/oauth-protected-resource     # → AS pointer
curl -si -X POST https://<service-url>/mcp -H 'content-type: application/json' -d '{}' \
  | head -3                                                            # → 401 + WWW-Authenticate
```

> **Note:** use `/health`, not `/healthz`, for external checks. Google's Front End
> reserves the literal path `/healthz` and returns its own 404 before the request
> reaches the container, so `/healthz` is only reachable by a container-internal
> probe. `/health` is the same handler on a non-reserved path.
