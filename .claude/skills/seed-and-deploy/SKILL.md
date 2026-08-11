---
name: seed-and-deploy
description: Safely re-seed the Firestore KG store from sources/ and roll the change out to the deployed server. Use whenever re-seeding Firestore, running `npm run seed:kg-store`, pushing a curriculum / knowledge-graph change into the store, verifying the store after a seed, or coordinating a seed with a Cloud Run deploy.
---

# Seed the KG store + deploy safely

Re-seeding Firestore and deploying the server are **coupled** — get the order or the pairing wrong and generation silently drops content with no error. Follow this checklist rather than running the seed on its own.

## The two things that cause silent outages

1. **Store shape ↔ server code must match.** The store holds the *full* Learning-Commons graph — the curriculum spine **plus** framework/derived nodes and the real `supports` / `relatesTo` edges. The server must run code that reads that shape (the `toRawEnvelope` + `adapter.parse` hydration, from PR #22 onward). An **older** server reading a full-graph store follows only `hasChild` edges, so it drops the learning components/tasks it hands the generator — no crash, just missing content in the output. **Rule: deploy the matching server code together with (or before) the store it will read.** Never leave an old server pointed at a freshly full-graph-seeded store.

2. **The seed writes slot `a`, which may not be the published slot.** The store is double-buffered (`a` / `b`) behind a pointer `{ publishedSlot, draftSlot }`. `seed:kg-store` **always** writes slot `a` and only stamps the pointer the *first* time. If someone has since published a draft, the pointer points at `b`, so a re-seed writes a **stale side-copy that nothing reads**. The seed script prints a `WARNING` in this case — read its output, don't assume success.

## Prerequisites (local run)

The seed/parity scripts need these in the shell you run them from:

- `SERVICE_ACCOUNT_KEY_PATH` — path to the Firebase service-account JSON
- `FIREBASE_STORAGE_BUCKET`
- `KG_SOURCE=firestore`

Never print or commit the service-account key. (On Cloud Run there is no key path — the runtime service account supplies credentials.)

## Procedure

1. **Build first** — the seed and parity scripts run from `dist/`, so stale `dist/` silently seeds stale data:
   ```bash
   npm run build
   ```

2. **Dry-run** (optional; no writes — uses an in-memory store):
   ```bash
   node scripts/seed-kg-store.mjs --dry-run
   ```

3. **Seed** — every installed grade/subject, or a single pair:
   ```bash
   KG_SOURCE=firestore npm run seed:kg-store                      # all contexts
   KG_SOURCE=firestore node scripts/seed-kg-store.mjs ci maths    # one pair
   ```

4. **Read the seed output** and confirm both:
   - **No stale-slot `WARNING`** — if present, the published pointer isn't `a`; reconcile deliberately before trusting the seed (see `docs/technical-reference.md`).
   - **Node/edge counts match the source graph.** The counts should equal the raw `sources/<grade>/<subject>/knowledge_graph.json` totals — the *full* graph, not a spine subset. Current values:

     | context | nodes | edges |
     |---|---|---|
     | ci/maths | 397 | 773 |
     | ce1/reading | 1401 | 1362 |

     If you instead see the old spine-only numbers (ci/maths 355/586, ce1/reading 535/513), the build is stale — rebuild (step 1) and re-seed.

5. **Verify reads** match the source bundle (read-only, safe to run against production):
   ```bash
   npm run parity:kg-store -- --live
   ```
   Healthy output ends with `parity-check: all backends match.` A `DIFF` means live reads diverge from the source — do not roll out; investigate.

6. **Deploy the matching server** — only when the server code changed too. From repo root (full command + env in `DEPLOY.md`):
   ```bash
   gcloud run deploy senegal-mohebs-tlm --source . \
     --project senegal-ci-maths --region europe-west1 \
     --service-account tlm-server@senegal-ci-maths.iam.gserviceaccount.com ...
   ```
   Then smoke-check:
   ```bash
   curl -s https://<service-url>/healthz     # → ok
   ```

## Safety notes

- Seeding **overwrites slot `a`**, so it clobbers a curator's in-flight draft if that draft lives in `a`. Coordinate before re-seeding a live environment.
- `sources/` ships inside the container image — **adding a grade/subject requires a redeploy**, not just a re-seed.
- The seed and the live parity check both hit real Firestore; confirm you are pointed at the intended project/bucket before running.
