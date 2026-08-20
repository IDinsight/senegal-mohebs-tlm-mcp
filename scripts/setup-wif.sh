#!/usr/bin/env bash
#
# One-time: let this repo's GitHub Actions deploy to Cloud Run WITHOUT a JSON
# service-account key, via Workload Identity Federation (WIF).
#
# GitHub Actions presents a short-lived GitHub OIDC token; GCP trusts it (scoped
# to THIS repo only) and lets the workflow impersonate a dedicated deployer
# service account. No long-lived secret ever leaves GCP. See DEPLOY.md → "CD".
#
# Run under your own gcloud user creds (`gcloud auth login`); it needs project
# IAM-admin rights. Safe to re-run — every step is create-if-absent.

set -euo pipefail

PROJECT="senegal-ci-maths"
REPO="IDinsight/tlm-authoring-mcp"       # owner/repo, exactly as on GitHub (case-sensitive)
POOL="github"                            # workload identity pool id
PROVIDER="github-tlm"                    # OIDC provider id inside the pool
DEPLOYER="github-deployer"               # deployer service account id
RUNTIME_SA="tlm-server@${PROJECT}.iam.gserviceaccount.com"  # the SA the deployed service RUNS AS

gcloud config set project "$PROJECT"

# Project NUMBER (not id) is what the trust principal is keyed on — resolve it
# here so it can never be a mis-pasted literal.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
echo "Project number: $PROJECT_NUMBER"

# --- Pool + GitHub OIDC provider ------------------------------------------------
# The pool is a trust boundary; the provider inside it trusts GitHub's OIDC
# issuer. The attribute-condition is the security fence: ONLY tokens whose
# `repository` claim is exactly this repo are accepted — no other repo or fork.
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create "$POOL" \
    --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers describe "$PROVIDER" \
    --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --location=global --workload-identity-pool="$POOL" \
    --display-name="tlm-authoring-mcp" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '${REPO}'"

# --- Dedicated deployer service account ----------------------------------------
# Separate from the runtime SA on purpose: the deployer needs build/deploy/push
# rights the running server must never have; the runtime SA stays minimal.
DEPLOYER_SA="${DEPLOYER}@${PROJECT}.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$DEPLOYER_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$DEPLOYER" \
    --display-name="GitHub Actions deployer (Cloud Run)"

# Deploy-time roles: build the image (Cloud Build), push it (Artifact Registry),
# stage the source tarball (Storage), and create/update the service (Run).
for ROLE in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.writer \
  roles/storage.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${DEPLOYER_SA}" --role="$ROLE" >/dev/null
done

# The service RUNS AS the runtime SA, so the deployer must be allowed to "act as"
# it — otherwise `run deploy --service-account tlm-server@...` is denied.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:${DEPLOYER_SA}" \
  --role=roles/iam.serviceAccountUser >/dev/null

# --- Trust: this repo's Actions may impersonate the deployer -------------------
# principalSet keyed on the repository attribute → any workflow run FROM this
# repo (any branch/tag) maps to this deployer SA. Tighten to attribute.ref later
# if you want to restrict which branches/tags can deploy.
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" >/dev/null

# --- What the workflow needs ----------------------------------------------------
echo
echo "Done. Wire deploy.yml with:"
echo "  workload_identity_provider: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
echo "  service_account:            ${DEPLOYER_SA}"
