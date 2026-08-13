# Workspaces (multi-tenant KGs + scoped roles)

**Status:** Implemented in code (2026-08-13) on branch `feat/workspaces`; the
Firestore reseed + Cloud Run deploy + membership migration (the "Migration"
section) are **not yet run** — that is the operational rollout, pending a go.
All code + tests are green (`npm run build` + `npm test`).

## Why

Today the server hosts a flat pool of curriculum graphs keyed by
`(grade, subject)`, and a caller's role (`curator` / `approver`) is **global** —
it applies to every graph. That only works while every graph belongs to the same
programme. The moment we add graphs "from other places" (other countries /
partners), two things break:

1. **Key collisions.** `(grade, subject)` stops being unique. Senegal has
   `(ci, maths)`; Kenya could have its own `(ci, maths)`. The store keys
   everything off the namespace string `ci/maths`, so the two would land on the
   same graph.
2. **Role blast radius.** A curator hired for Senegal would silently be a curator
   for Kenya too. There is no way to say "curator here, nothing there."

A **workspace** is the tenant boundary that fixes both: a named container that
owns a set of `(grade, subject)` graphs, and the unit that roles are scoped to.
The two existing graphs become the **Senegal** workspace; new programmes are new
workspaces.

## The model

### Workspace is the top segment of the namespace key

```
today:      ci/maths            ce1/reading
proposed:   senegal/ci/maths    senegal/ce1/reading    kenya/ci/maths   …
```

`kgNamespace()` gains a `workspace` argument, sourced from the active context:

```ts
kgNamespace(workspace, grade, subject) = `${basePrefix()}${workspace}/${grade}/${subject}`
```

The storage layer already supports this with no schema change: Firestore filters
by a `namespace` **field** (not a folder path), and `nsSlug()` already flattens
every `/` into `__` for doc ids. The draft/published double-buffer (slots `a`/`b`
+ pointer) is keyed by namespace, so each workspace's graphs get their own
independent draft/publish lifecycle for free.

### Role tiers (each a strict superset within a workspace)

| Tier | Scope | May |
|---|---|---|
| **super admin** | all workspaces | everything, incl. create/delete workspaces + grant any role |
| **admin** (workspace admin) | one workspace | manage that workspace's members + everything approver can |
| **approver** | one workspace | publish + everything curator can |
| **curator** | one workspace | stage / apply / discard drafts, read draft |
| _(no membership)_ | — | cannot enter the workspace (see read isolation) |

Being a curator in `senegal` grants nothing in `kenya`. Super admin is the only
cross-workspace tier.

### Read isolation

Today reads and generation are **ungated** — any signed-in (even unknown) actor
can read any graph. With tenants that is wrong: a Kenya user should not browse
Senegal's curriculum. We gate at **workspace entry** rather than at every read
tool: `set_context(workspace, …)` requires the caller to be a member of (or super
admin over) that workspace. Reads within a workspace stay ungated *once you're
in*, so no read tool changes — but you can only enter a workspace you belong to.
This is the recommended default; it trades the current "anyone can read anything"
property for tenant isolation, which is the point of workspaces.

## Where membership lives

Split **identity** from **authorization**:

- **Identity stays in Supabase.** The verified JWT still provides `sub` + `email`
  (`resolveActor`, unchanged). That is Supabase's job and stays there.
- **Membership moves to Firestore.** Workspace/role is *our* domain concept, and —
  critically — workspace admins must manage their own members at runtime, which
  the current SQL-table-only model cannot do. Two new collections:
  - `workspaces` — `{ id, displayName, createdBy, createdAt, archived? }`. The
    registry `list_workspaces` / `create_workspace` read and write.
  - `workspace_members` — doc id `${workspace}::${userId}`, body
    `{ workspace, userId, email?, role: "curator"|"approver"|"admin",
    grantedBy, grantedAt }`.
- **Super admins bootstrap from env.** `TLM_SUPER_ADMINS` = comma-separated JWT
  `sub`s (or emails) breaks the chicken-and-egg: with no admin yet, someone must
  be able to create the first workspace and appoint the first workspace admin.
  Super admins are env-rooted in v1 (not stored, not grantable at runtime).

The Supabase `app_role` claim becomes **vestigial** — read but no longer used for
authorization. Removed in a later cleanup once migration is confirmed.

## Layering — keeping authz pure

`authorize()` is a pure, **synchronous** leaf function today, and every call site
calls it synchronously. Reading membership from Firestore inside it would force it
async and touch every chokepoint. Instead:

- **Resolve membership once per request, in the app layer** (`http.ts`, where the
  actor is installed). One Firestore read of the caller's few membership rows,
  attached to the `Actor`:
  ```ts
  interface Actor {
    // …identity (unchanged: id, email, tokenIssuer, unknown)…
    readonly superAdmin: boolean;
    readonly memberships: Readonly<Record<string /*workspace*/, EffectiveRole>>;
  }
  ```
- `authorize(actor, action, namespace)` **stays pure and sync**: derive the
  workspace from the namespace's first segment, read `actor.memberships[ws]` (or
  `superAdmin`), apply the tier rules. No new import, no async.

New module `src/workspaces/` (services layer): a Firestore-backed store for the
two collections + a memory impl for tests (mirroring `kg-store`'s
`createMemoryKgStore` / `__setStoreForTest` pattern). It is added to the `LAYERS`
map in `check-cycles.mjs`. Layering holds: **app** (`http.ts`) reads the
**services** store, builds `Actor.memberships`, and hands it to **core**
(`authz.ts`) — imports only ever point down. `authz` never imports `workspaces`.

## Surface changes

### `authz.ts`
- `EffectiveRole = "curator" | "approver" | "admin" | "super_admin"`.
- New actions: `manageMembers` (admin+), `manageWorkspace` (super admin only:
  create/delete workspace, grant super admin — a no-op in v1 since super admins
  are env-only).
- `apply`/`discard`/`readDraft` → curator+; `publish`/`readAudit` → approver+.

### `actor.ts`
- Drop the global `role`; add `superAdmin` + `memberships` (see above).
- `resolveActor` stays identity-only; a new pure helper `withMemberships(base,
  memberships, superAdmin)` produces the full actor. Membership *reading* is
  app-layer, so `actor.ts` gains no Firestore dependency.

### Context (`context/*`, `activate.ts`)
- `ActiveContext = { workspace, grade, subject }`.
- `set_context(workspace, grade, subject)` — validates the workspace exists and
  the caller may enter it; then the existing schema-guard + bind flow, now keyed
  by the 3-tuple namespace.
- `listAvailableContexts()` scans `sources/<workspace>/<grade>/<subject>/`.
- Per-user persisted context `_state/<sub>.json` widens to
  `{ workspace, grade, subject }`; a legacy 2-field file defaults `workspace:
  "senegal"` on restore.

### New tools
- `list_workspaces` — the workspaces the caller may enter (all, if super admin).
- `create_workspace(id, displayName)` — super admin only.
- `add_member(workspace, userId|email, role)` / `remove_member(workspace,
  userId)` — admin+ for their workspace; super admin anywhere. A workspace admin
  may grant curator/approver/admin but **not** super admin.
- `list_members(workspace)` — admin+.

Membership tools write **live** (not through the draft/publish two-phase — a
membership is not a graph node), but every change writes an **audit record** (new
event types `membership` / `workspace`) via the existing audit machinery.
Destructive `remove_member` may take a confirmation token later; v1 is direct.
Guardrail to note: refuse removing the **last admin** of a workspace.

### `get_capabilities`
Extends its read-only mirror with the new admin actions, sourced (as today) from
the same `authorize()` it mirrors — no copied policy.

## Migration (breaking — code + data ship together)

Namespace paths change **in two stores** — the Firestore KG *and* the Storage
bucket (documents + history are workspace-scoped too, `<ws>/<grade>/<subject>/…`).
The deployed code must change in lockstep with the reseed. Order is **additive
first** (new paths alongside old, so the running old server stays up), then
deploy, then verify, then delete the old paths.

1. **Reorg sources:** `git mv sources/ci sources/senegal/ci`,
   `git mv sources/ce1 sources/senegal/ce1`.
2. **Reseed the KG** under `senegal/ci/maths` + `senegal/ce1/reading` (via the
   seed-and-deploy skill). These are new namespaces, so it's additive — the old
   `ci/maths` / `ce1/reading` docs are untouched.
3. **Move the Storage artifacts** — copy the generated `.docx` + `history.json`
   from the old prefixes to the new (additive; keep old as rollback):
   `gcloud storage cp -r gs://<bucket>/ci  gs://<bucket>/senegal/` and
   `…/ce1 …/senegal/`. `_state/` is *not* workspace-scoped and needs no move
   (legacy 2-field state files default to `senegal` on restore). Skip `previews/`.
4. **Set `TLM_SUPER_ADMINS`** to the initial super admin (an email or JWT `sub`),
   passed as a Cloud Run env var.
5. **Deploy Cloud Run** with the new code + the env var
   (`--update-env-vars TLM_SUPER_ADMINS=…` merges, preserving existing env).
6. **Deploy the explorer** (Firebase Hosting) so its selector groups by workspace:
   `firebase deploy --only hosting`.
7. **Verify against the live MCP server** (not just `parity --live`): `set_context`
   into the workspace, `list_units` (KG reads), `list_documents` / `reconcile`
   (Storage reads), `get_capabilities` (super-admin + workspace echo). Check the
   explorer selector shows the workspace group.
8. **Optional — populate the registry:** `create_workspace senegal` +
   `add_member` for each user, to retire the legacy `app_role` bridge. Until then,
   existing Supabase-role users keep working in `senegal` via the bridge.
9. **Cleanup (only after verification):** delete the old KG namespaces
   (`node scripts/delete-namespace.mjs --confirm`, which leaves `kg_audit`) and the
   old Storage prefixes (`gcloud storage rm -r gs://<bucket>/ci gs://<bucket>/ce1`).

**Gotcha this migration surfaced:** the Storage document/history move (step 3) is
easy to forget because the *reseed* (step 2) only touches Firestore. Miss it and
`list_documents` / `reconcile` read empty on the new paths even though generation
works — the artifacts are just orphaned under the old prefix.

## Open decisions folded in (defaults chosen)

- **Membership store = Firestore** (enables admin self-service). ✔ chosen.
- **Read isolation at workspace entry**, not per-read-tool. ✔ chosen (flagged).
- **Super admins env-rooted in v1**, runtime super-admin grants deferred.
- **Membership tools write live + audited**, not two-phase drafted.

## Non-goals (v1)

- Runtime management of super admins (env-only).
- Per-graph (as opposed to per-workspace) roles.
- Cross-workspace graph moves/sharing.
- Public/read-only workspaces (all workspaces are membership-gated).
