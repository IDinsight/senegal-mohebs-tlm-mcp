# Add a workspace or a subject

This page covers two setup tasks:

- **Create a workspace and manage its members** — done **by chatting with Claude**, by an administrator.
- **Add a new subject** (with its starter graph) — requires writing **code** and running **commands**: this is a **developer** task, needing repository and deployment access.

The two target different audiences: the first needs no technical skill; the second does.

---

## Part 1 — Workspaces and members (by chatting)

### What is a workspace?

A **workspace** is the container for a programme (for example *Senegal* or *Kenya*). It owns all the curriculums for that programme, and it is at this level that **roles** are granted. Its identifier becomes the first segment of every internal address: `senegal/ci/maths`, `kenya/ci/maths`, and so on.

### Roles, from broadest to narrowest

| Role | Reach | May… |
|---|---|---|
| **super admin** | all workspaces | everything, including creating/deleting workspaces and granting any role |
| **admin** | one workspace | manage that workspace's members, plus everything an approver does |
| **approver** | one workspace | publish, plus everything a curator does |
| **curator** | one workspace | prepare, apply, discard drafts |
| *(no role)* | — | cannot enter the workspace |

The **super admin** role is **not grantable** from the tool: it is set by a server environment variable (`TLM_SUPER_ADMINS`), by a developer.

### Create a workspace

Reserved for the **super admin**:

> "Create a workspace 'kenya', display name 'Kenya'."

The identifier must be a short slug (`kenya`). Creating the workspace **does not create** its curriculums: importing them is a separate step (see Part 2).

### Manage members

Reserved for the workspace's **admins** (or the super admin):

> "Add this user as a curator of the Senegal workspace."
>
> "List the members of the Senegal workspace."
>
> "Remove this user from the Senegal workspace."

A user's identifier is their identity subject (the `sub` on their token). A few guardrails:

- re-granting a role **updates** the existing role;
- you **cannot remove the last admin** of a workspace — appoint another one first;
- an admin **cannot** grant the super admin rank.

Every workspace or member change is **immediate** (no draft) and **logged**.

---

## Part 2 — Add a new subject (code + commands)

!!! warning "Developer task"
    This part assumes access to the code repository and to deployment (Cloud Run). All commands are run from the `backend/` folder (`cd backend` first). When in doubt, lean on the internal **seed-and-deploy** skill, which walks through the procedure step by step.

Adding a subject is **code, then data**.

### Step 1 — Describe the subject (code)

Each subject is described by a **profile** (`SubjectProfile`), a configuration object — no behaviour code to write. Add a file under `backend/src/adapters/profiles/`, modelled on `ci-maths.ts`. The profile tells the tool how to read this subject's graph (where unit ordering comes from, which containment links to follow…) and can carry a markdown **guide** that generation will read.

### Step 2 — Register the profile (code)

In `backend/src/adapters/index.ts`, add the `"<grade>/<subject>"` key to the profiles table (and to the guides table if the subject has one). Several grade/subject pairs can point at the same profile when their graphs share a shape.

### Step 3 — Build and deploy

Since the profile is code, a **server redeploy** (Cloud Run) is required for the new subject to be recognised.

```bash
npm run build
```

### Step 4 — Import the graph (data)

Once the subject is known to the server, import its starter graph:

```bash
npm run import:kg-store -- <workspace> <grade> <subject> <graph.json>
```

Add `--dry-run` for a trial run (nothing is written). The import **refuses** to run if no profile is registered for the subject — hence the order: code first, data second.

!!! danger "The trap of importing over an existing workspace"
    The import **always** writes to slot `a` and **never repoints** an already-existing namespace. On a fresh namespace, this is perfect. On an already-published namespace, your graph lands in a copy **nobody reads**: to publish it you must go through the curator loop (which does flip the pointer). Import is meant for a **new** namespace, a restore, or a clone.

### What the graph file looks like

It is a **Learning Commons** envelope: `{ nodes, relationships }`. The `nodes` are labelled nodes (framework, objective, lesson…) with their properties; the `relationships` are the typed links between them (containment, alignment…). Stored as canonical LC.

### Back up (the inverse of import)

Before any manipulation, make a **backup** by exporting the published graph:

```bash
npm run export:kg-store -- <workspace> <grade> <subject> [out.json]
```

The produced file re-imports as-is to restore or clone. Both scripts need Firebase access (variables `SERVICE_ACCOUNT_KEY_PATH`, `FIREBASE_STORAGE_BUCKET`, `TLM_BUCKET_PREFIX`).

### Verify after import

- `set_context` must **activate** the subject (an invalid profile is refused at activation);
- an overview ("give me a snapshot of this subject") must return the expected counts;
- the subject's guide must be the one you intended.

### Editing an existing subject ≠ adding one

Tweaking the **profile** or the **guide** of a subject **already in place** needs **no code and no redeploy**: it is done by chatting, like a curriculum edit (preview → confirm → draft → publish). Only adding a *new* subject goes through code.
