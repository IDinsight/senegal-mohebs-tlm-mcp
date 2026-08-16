# Graph-linked documents — a document's identity is the node it covers

> **Status: steps 1–2 built (in-repo); steps 3–4 proposed.** This note designs the
> replacement for the profile's `deliverables` concept: a generated `.docx` is
> identified by the **graph node it covers**, not by a `(unit, deliverable)`
> coordinate. It is the "documents-as-nodes" follow-up flagged in
> [`authorable-catalog.md`](authorable-catalog.md) (D4 / the deliverables removal),
> and it retires `deliverables`, `get_prompt`, and the filename-classification
> half of `reconcile`.
>
> **Step 1 (built).** The history is re-keyed by `nodeId`: `record_document_content`
> / `log_generation` take a `nodeId` (validated against the active graph) instead
> of `(unit, deliverable)`; `reconcile` is now **discover-only** (diffs the bucket
> against history by `relPath`, no filename classification); `list_documents`
> pages/filters by node. A pre-node-keyed (v2) `history.json` is ignored on load —
> its docs re-surface as untracked for a one-time re-link (the "fresh reconcile"
> migration below). Each entry keeps a **transitional** `unit` hint (the scope
> node's ordinal, stamped at record time) purely so CI-maths example-domain
> rotation keeps working until generation goes graph-native (step 4); it is not
> parsed from the filename and carries no deliverable. `deliverables` itself is
> untouched in step 1 — its removal is step 2.
>
> **Step 2 (built).** `deliverables` is removed from the profile: the schema field,
> the three profile literals, `build.ts`'s `classifiers()`, `DeliverableSpec` /
> `DeliverableKey` / `DocType`, `SubjectAdapter.deliverables`, and `badDeliverable`
> are all deleted. Because `get_prompt` read `DeliverableSpec.promptFile`, it is
> retired with them (its file removed from the tool registry). **Update (step 3
> done for maths):** the two CI-maths `PROMPT_*.md` files are now **deleted** — their
> Bucket-C heuristics moved into the CI-maths graph guide, their structure into the
> chapter/lesson routines, and their subject-specific docx layout into per-deliverable
> workspace formatters (the shared house style re-attached to the Teacher's Guide).
> The CE1-reading `PROMPT_generate_lessons.md` remains until reading gets a
> content-layer `Course` to carry its phase-spine routines + formatter. A
> **transitional** Zod preprocess strips a legacy `deliverables` key so
> already-seeded profile cells keep activating through the re-seed. `preview_generation`
> already took a `course` id (no code change); only its stale "unit + deliverable"
> capability text was corrected.

## Why `deliverables` stopped making sense

A **deliverable** was a per-subject config entry — `manual`, `lessons`,
`teacher_guide` — carrying a `scopeKind` (which unit-kind one document covers), a
`classify(filename)` rule, a `promptFile`, and `dependsOn`. It predates the
graph-native content layer. Today it is a **stand-in for a distinction the graph
already encodes structurally.**

CI maths has **two Courses**:

- the **Student's Book** → `Chapitre`s → lessons, and
- the **Teacher's Guide** → weeks → `Lesson`s.

A generated *pupil manual for chapter 5* is really "the document for **this
`Chapitre` node** (under the Student's Book)." A generated *lesson sheet* is "the
document for **this `Lesson`/week node** (under the Teacher's Guide)." The
manual-vs-lessons split **is** the which-Course-which-node split. CE1 reading has
one Course, so its week guide is "the document for **this `Semaine` node**."

Once a document points at the node it covers, the deliverable "type" **falls out of
where that node lives** in the graph (which Course, which label) — there is nothing
left for a `deliverables` enum to carry. That is the whole idea.

## The model: a document covers a "scope node"

Every generated document **covers exactly one graph node** — the root of the
subtree it renders. Call it the document's **scope node**:

| document | scope node | (was: deliverable) |
|---|---|---|
| pupil manual, chapter 5 | the `Chapitre` node (Student's Book) | `manual` + unit 5 |
| lesson sheets, chapter 5 | the chapter's `Lesson`/week node (Teacher's Guide) | `lessons` + unit 5 |
| reading week guide, week 3 | the `Semaine` node | `teacher_guide` + unit 3 |

The **history entry** becomes keyed by that node id:

```
// today:  { id: `${unit}:${type}`, unit: number, type: deliverableKey, relPath, md5, content }
// proposed: { id: nodeId, nodeId, relPath, md5, content }
```

`unit` and `type` disappear. Everything a caller used them for is derivable from
the node: its kind (`Chapitre`/`Semaine`/…), its ordinal (`position`/`order`), and
which Course it sits under — all already in the graph, reachable with `walk_graph`.

**Where the link lives — a cache keyed by node id, not edges in the curriculum
graph.** Generated `.docx`es are *outputs*, not curriculum, so they do **not**
become nodes/edges in the draft/publish graph — that loop stays about the
curriculum a curator authors. The history stays the separate bucket-side cache it
is today; only its **key** changes from `(unit, deliverable)` to `nodeId`. (An
alternative — a `hasGeneratedDocument` edge on the curriculum node — was
considered and rejected: it would drag output-tracking into the curriculum's
draft/publish loop and let a graph publish churn on document metadata.)

## What each piece becomes

### `deliverables` — removed from the profile

The `deliverables` array leaves `SubjectProfile` entirely: no `key`, `scopeKind`,
`match`/`classify`, `dependsOn`, or `promptFile`. `SubjectAdapter.deliverables`
and `DeliverableSpec` go with it, along with the `badDeliverable` guard.

### `get_prompt` — dissolves into the guide + the node's attachments

`get_prompt` served a per-deliverable `promptFile`. In the graph-native world the
generation guidance for a node is **assembled**, not served from one file:

- **the graph guide** (`get_graph_guide`) — the subject's conventions;
- **the node's routine** (`usesRoutine` → structure: "structure of a chapter in 6
  sections", "fiche de leçon in 5 steps") — already in the catalog;
- **the node's / Course's formatter** (`usesRoutine` → house style + layout) —
  already in the catalog;
- **the content** — `walk_graph` / `get_standards` from the scope node down.

So `get_prompt` retires. The residual Bucket-C authoring heuristics that still live
in the `PROMPT_*.md` files (invent misconception distractors, pick an everyday
Senegalese scene, …) move into the **guide** (or a routine), and the files are
deleted. The generating model calls `get_graph_guide` + walks the node's subtree +
reads its attached routine/formatter — no per-deliverable prompt.

### `reconcile` / `list_documents` — discover, then link (no filename classification)

`reconcile` today maps a bucket object to `(unit, deliverable)` by parsing the
folder number and running `classify(filename)`. With no deliverables there is no
`classify`, so reconcile **stops auto-classifying** and becomes a two-step:

1. **discover** — list bucket objects whose `relPath` is in no history entry →
   report them as *untracked* (with their `relPath`, md5);
2. **link** — the curator/LLM records each untracked doc against the node it covers
   via `record_document_content(nodeId, relPath, content)`.

`list_documents` stays (now ordered by node/Course rather than `unit:type`), and
`log_generation` / `record_document_content` take a **`nodeId`** instead of
`(unit, deliverable)`. `create_upload_url` / `create_download_url` /
`get_document_text` are unchanged — they key on `relPath`, which is unaffected.

`relPath` stays a human-readable storage location (e.g.
`chapitre_05/Manuel - Chapitre 5.docx`); it is **no longer parsed for identity**.
The identity is the `nodeId` the write path records.

## Migration

The live history is keyed `(unit, deliverable)`. Two options, in increasing effort:

- **Fresh reconcile (recommended first cut).** Ship the re-keyed schema; on first
  run, existing entries are treated as untracked and re-linked to their nodes
  (each `(unit, deliverable)` maps to a node by walking the Course for the matching
  kind + ordinal). A one-time `reconcile` + confirm re-establishes the trail.
- **Automated backfill.** A migration script maps each `(unit, deliverable)` entry
  to its node id up front (deliverable → Course, unit → the `position`-matching
  node), rewriting the history file in place. More work; avoids a manual re-link.

Either way the bucket objects and their `relPath`s are untouched — only the
history file's keys change.

## Decisions at a glance

| # | Decision | Proposed |
|---|---|---|
| G1 | Document identity | The **graph node** the document covers (its scope node), replacing `(unit, deliverable)` |
| G2 | Where the link lives | A **bucket-side history cache keyed by `nodeId`** — NOT edges in the curriculum draft/publish graph (outputs aren't curriculum) |
| G3 | `get_prompt` | **Retired** — guidance = `get_graph_guide` + the node's routine/formatter + `walk_graph`; residual heuristics move into the guide |
| G4 | `reconcile` classification | **Removed** — reconcile discovers untracked docs; the curator/LLM links each to a node (no filename→deliverable) |
| G5 | `deliverables` in the profile | **Removed entirely** (with `DeliverableSpec` / `badDeliverable`) |
| G6 | Migration | **Fresh reconcile** first cut (re-link on first run); automated backfill optional |

## Open questions

- **Multi-node documents.** A document that spans several nodes (a whole-book PDF)
  has no single scope node. Out of scope for the first cut — every current
  deliverable is per-chapter/per-week, i.e. one scope node. If it arises, the entry
  could carry a small `coversNodeIds[]` instead of one `nodeId`.
- **Which node exactly for maths lessons.** The teacher-guide "lessons" document for
  a chapter covers that chapter's `Lesson`s — is its scope node the `Chapitre`
  (content axis) or the week (schedule axis)? Likely the `Chapitre` for symmetry
  with the manual, with the week reachable via the lesson's second parent. Confirm
  when wiring generation.
- **Generation entry point.** `preview_generation(course)` and the live generation
  flow are scoped today by a course id + unit; they would take the **scope node id**
  instead. A small change, but it touches the generation prompt wiring — sequence it
  after the profile/deliverable removal so generation reads a clean surface.

## Build order (when this is greenlit)

1. **Re-key the history** *(built)* — `{ nodeId, relPath, content }`;
   `list_documents` / `log_generation` / `record_document_content` take `nodeId`;
   `reconcile` drops classification and becomes discover-only. (Storage + server
   tools.) A transitional `unit` ordinal hint is stamped from the node at record
   time so domain rotation survives until step 4.
2. **Remove `deliverables`** *(built)* — from the profile schema, the three
   profiles, `build.ts`, `DeliverableSpec`, `badDeliverable`, and the capabilities
   mirror. Retiring the `get_prompt` **tool** came with it (it read
   `DeliverableSpec.promptFile`); a transitional preprocess strips a legacy
   `deliverables` cell key through the re-seed.
3. **Retire `get_prompt`** — the tool is gone (step 2); the remainder is to move
   the residual Bucket-C heuristics from the `PROMPT_*.md` files into the guides
   (a live-data authoring task via `edit_profile`), then delete the files.
4. **Point generation at the scope node** — `preview_generation` + the generation
   flow key on a node id.

Each step is independently shippable; step 1 is the substantive one and can land
before the profile change.

## Related

- [`authorable-catalog.md`](authorable-catalog.md) — the deliverables removal (D4)
  this note fulfils; the guide + catalog (routines/formatters) that absorb the
  prompt.
- [`graph-native-authoring.md`](graph-native-authoring.md) — the content layer +
  the two-Course structure that makes "deliverable = which Course" true.
- [`../technical-reference/generation-and-storage.md`](../technical-reference/generation-and-storage.md)
  — the current document/history/reconcile subsystem this re-keys.
