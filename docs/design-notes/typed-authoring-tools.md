# Typed authoring tools — an LC-grounded mutation surface

> **Status: RETIRED — superseded by `add_nodes`.** The 9 per-LC-label typed adds
> (`add_lesson`, `add_standard_framework_item`, …) were removed: they were thin
> facades over the same `addNode` recipe, so **`add_nodes`** (one node or many,
> `src/server/authoring.ts`) now covers every case. The per-kind property
> vocabulary they documented was preserved in `KIND_PROPERTIES` (mirrored by
> `get_capabilities` under `editable.batch.kindProperties`) and in the `add_nodes`
> tool description, so nothing was lost. Read the per-tool sections below as
> historical; the LC grounding they describe still applies to `add_nodes`'
> `kind` + `properties`. The edge/delete verbs (`create_edges` — which likewise
> retired the single `create_edge` — plus `delete_edges`/`delete_nodes`) and
> `reposition`/`set_content` are unchanged.
> Boilerplate is still copied from a sibling node (`kg-recipes/lc.ts`). Current
> surface: [`graph-native-authoring.md`](graph-native-authoring.md).

## Why typed, not generic

The generic `add_node(parentId, label, properties)` works, but it pushes the whole
Learning-Commons schema onto the caller: which `label`, which containment edge, which
required properties, which alignment. A **typed** tool per node type carries that
knowledge itself — `add_lesson` knows a lesson nests under a `LessonGrouping` by
`hasPart`, requires `audience`, and usually aligns to a standard. The caller supplies
only the few meaningful fields; the tool is the schema.

This is the same "put the knowledge where it belongs" move as the rest of the
project: the LC schema lives in the tool, so the author (expert or LLM) doesn't
re-derive it every time.

## The two trees (why `alignTo` exists)

The graph is **two trees**, bridged by a third edge — the single most important thing
to understand before reading the tool table:

1. **Content** (the book): `Course → LessonGrouping → Lesson → Activity → Material`,
   nested by **`hasPart`**. Where a node *sits*.
2. **Standards** (the objectives): `StandardsFramework → SFI → SFI`, nested by
   **`hasChild`**. What students must *learn*.
3. **The bridge:** a content node **teaches** a standard via
   **`hasEducationalAlignment` → SFI** (and a `LearningComponent` **`supports` → SFI**).

So adding a lesson is usually *two* edges: `parentId` files it in the book
(`hasPart`), and **`alignTo`** says which standard it teaches
(`hasEducationalAlignment`). A content node with no alignment floats free — you can't
tell which objective it covers. Every content `add_*` therefore takes an optional
`alignTo`, so both edges are set in one atomic call.

## The surface

**Removed:** `add_node`, `create_node`, `move_node`.
**Renamed:** `link_nodes` → `create_edge`; `unlink_nodes` → `delete_edges`;
`delete_node` → `delete_nodes`.
**Kept:** `reposition`, `set_content`, `upsert_property`.
**New — 9 typed adds** (below).

Re-parenting (formerly `move_node`) is now `delete_edges` (old containment) +
`create_edge` (new) — two ops, batched atomically if needed.

### Auto-filled boilerplate (the LC grounding, in practice)

Every LC node carries ~10 *machine* properties the author must never type. The typed
tools **fill these automatically** from the active `(workspace, grade, subject)`
context + canonical LC constants — exactly how the seeded nodes look:

`identifier` (server-minted UUID) · `license` (CC BY 4.0) · `provider` ·
`attributionStatement` · `academicSubject` (subject) · `gradeLevel` (grade) ·
`inLanguage` · `jurisdiction` (workspace) · `providerDateCreated`/`providerDateModified`
· plus the LC **identity skeleton** (`labels`, `normalizedType`, `metadata.role`)
copied from an existing node of that label, or canonical defaults for the first of its
kind.

"All relevant properties" in each tool below therefore means the **author-facing**
fields only.

### The 9 typed adds

Each bakes in its canonical edge and required LC props. `alignTo` (a `StandardsFrameworkItem` id) is optional and creates `hasEducationalAlignment`.

| Tool | Parent → edge | Required author props | Optional author props | `alignTo` |
|---|---|---|---|---|
| `add_course` | *(root — no parent)* | `audience`, `name`/`description` | `educationalUse`, `courseCode`, `timeRequired` | — |
| `add_lesson_grouping` | Course \| LessonGrouping → `hasPart` | `groupName` (e.g. "Chapitre"/"Semaine"/"Unité"), `groupLevel`, `audience` | `name`/`description`, `position`, `educationalUse` | ✓ |
| `add_lesson` | LessonGrouping → `hasPart` | `audience` | `name`/`description`, `position`, `educationalUse` (`Assessment` ⇒ bilan), `timeRequired` | ✓ |
| `add_activity` | Lesson → `hasPart` | `audience` | `name`/`description`, `position`, `studentGroupingType`, `timeRequired` | ✓ |
| `add_assessment` | Lesson \| LessonGrouping → `hasPart` | `audience` | `name`/`description`, `educationalUse` (default `Assessment`), `variant`, `timeRequired` | ✓ |
| `add_material` | Course \| LessonGrouping \| Lesson \| Activity \| InstructionalRoutine → `hasPart` | **`content`**, **`materialType`**, `audience` | `name`, `educationalUse` | ✓ |
| `add_learning_component` | StandardsFrameworkItem → **`supports`** | `description` | `examples` | *(the `supports` edge is the alignment)* |
| `add_standard_framework_item` | StandardsFramework \| SFI → `hasChild` | `normalizedStatementType` (Standard / Standard Grouping) | `description`, `statementType`, `statementCode`, `gradeLevel` | — |
| `add_instructional_routine` | InstructionalRoutine → `hasPart` | `name`/`description` | `position`, `timeRequired`, `summary` | — |

Notes on the non-content edges:
- **`add_learning_component`** attaches by `supports` (component → SFI), not
  containment. Its `parentId` *is* the SFI it supports; there is no separate `alignTo`.
- **`add_standard_framework_item`** nests by `hasChild` (the standards axis). SFI→SFI
  prerequisites (`buildsTowards`/`relatesTo`) are separate `create_edge` calls.
- **`add_instructional_routine`** builds the routine *tree* via `hasPart` (a parent
  routine → step routines → materials). **Applying** a routine to a Lesson/Course/
  Activity is `usesRoutine`, done with `create_edge` — the routine is authored once
  and applied to many.

### Primitives (edges, deletes, ordinal, content, wording)

- **`create_edge(type, fromId, toId)`** — any LC edge by type: `usesRoutine`,
  `buildsTowards`, `relatesTo`, `hasDependency`, or an extra `hasEducationalAlignment`.
  (The typed adds cover the common containment + one alignment; this is the rest.)
- **`delete_edges`** — remove one or more edges.
- **`delete_nodes`** — remove one or more nodes. **No `force` flag:** if a node has
  dependents, the dry-run **shows the full cascade** (the dependent subtree + every
  incident edge that will vanish) and **emits a warning**; the standard `confirm:true`
  then applies it. Seeing the cascade before confirming is the safety — not a block.
- **`reposition(nodeId, position)`** — sets `position`. Only valid on labels that have
  a `position` field in LC: `LessonGrouping`, `Lesson`, `Activity` (and our routine
  steps). Rejected on `Course`/`Material`/`SFI`, which have none.
- **`set_content(nodeId, content)`** — edits a `Material`'s load-bearing `content`
  (`upsert_property` is wording-only and can't reach it). `add_material` sets `content`
  at birth; `set_content` edits it later.
- **`upsert_property`** — wording edits (title/text and their `raw.*` mirrors), per the
  adapter's `wordingAliases`.

## Shared behaviour (unchanged envelope)

The 9 adds and the primitives are all graph mutations, so they keep the existing
framework verbatim:

- **Two-phase confirm** — a dry-run returns a diff + warnings + `confirmationToken` (no
  state change); `confirm:true` + the token applies to the **draft** only. This *is*
  the "confirm flag" — no per-tool flag is added.
- **Referential-integrity floor**, **append-only audit**, **per-workspace role gate**
  (curator/approver), **server-side id minting**.
- **One internal core, typed facades.** The adds are thin wrappers over a single
  internal "create a node of label L under `parentId` via canonical edge E, with props
  P, optional `alignTo`" — essentially the old `add_node`, kept internal. This keeps it
  DRY: the LC schema lives in the facades, the mutation machinery lives once underneath.

## What the closed set does *not* cover

Three LC labels have no add tool, by choice:

- **`StandardsFramework`** — the standards *root*; one per subject, created at seed
  time, not hand-authored.
- **`ClassroomMaterial`**, **`GlossaryTerm`** — gated LC labels, unused today.

If any of these ever needs runtime authoring, add a typed tool for it rather than
reintroducing a generic `create_node` — the point of the closed set is that every
creation path is LC-typed.

## Open / later

- **Batching** re-parent (`delete_edges` + `create_edge`) into one atomic call, if the
  two-op flow proves clumsy.
- **`get_capabilities`** mirror must be updated to advertise the new tool names.
- Whether `add_activity` should also accept our `metadata.illustratesComponent`
  extension (the RECE illustrative-task pattern) as an author prop.

## Related

- [`graph-native-authoring.md`](graph-native-authoring.md) — the content layer these tools author.
- [`logic-in-the-graph.md`](logic-in-the-graph.md) — why authoring lives in the graph.
- [`instructional-routines.md`](instructional-routines.md) — the routine subtrees `add_instructional_routine` builds.
- [`kg-mutations/`](kg-mutations/) — the two-phase mutation framework the tools run on.
- [`../reference/learning-commons/`](../reference/learning-commons/) — canonical node/edge schemas.
