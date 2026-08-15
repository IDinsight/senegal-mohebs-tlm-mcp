# Authorable catalog — subjects as data, curators as authors

> **Status: Live — the routine + formatter catalog is shipped, deployed, and verified
> (2026-08-14).** The catalog (routines and formatters, across a shared and a
> per-workspace scope) runs on the deployed server; the house-style formatter is applied
> to both CI-maths Courses, and a generated chapter was verified to take its style from
> the formatter. The subject-profile **config layer** (phase 2b) is built too:
> profiles are authored data in the store, edited through the curator loop with the
> schema guard at authoring time (`get_profile` / `edit_profile`). Phase 2c
> increments 1–2 are built too: the profile is a `{ core, guide }` record (machine
> `core` + authored markdown `guide` the LLM reads via `get_graph_guide`), and
> coverage expectations live in the guide with a `review_draft` tool that pairs
> them with the deterministic coded warnings (kept as the backstop). Still a
> **proposal**: retiring the coded coverage rules, the MCP **resources** browse
> surface (D5), reading's routine catalog (blocked on its content layer), and
> re-copy/detach ergonomics. This note extends
> [`logic-in-the-graph.md`](logic-in-the-graph.md) and
> [`instructional-routines.md`](instructional-routines.md) with a curator-facing layer.
> **D2 was revised from by-reference to copy-on-use during implementation** (see below).

## What shipped (the catalog)

Live on the deployed server, seeded, and verified end-to-end (PRs #77, #78, #79):

**The catalog — two scopes, two kinds.**
- **Two scopes** (D3): a shared `_shared/_catalog/routines` (cross-tenant) and a
  per-workspace `<workspace>/_catalog/routines`, resolved via `catalogNamespace(...)`.
  `list_catalog` reads both, unions them, and tags each entry with `scope`
  (shared | workspace) and `kind` (routine | formatter). Editing an entry is gated by
  its own namespace's authz — shared → super_admin, workspace → that tenant's curators.
- **Two kinds** (D1): **routines** (pedagogical structure → steps → Materials) and
  **formatters** (a house-style spec `Material`). Both are `InstructionalRoutine`
  entries under a root container; `kind` comes from `metadata.catalogKind`.
- Seeded by `scripts/seed-catalog.mjs` (`npm run seed:catalog`), which extracts each
  subject's routine subtrees and splices the authored `HOUSE_STYLE_FORMATTER` under one
  root. The live shared catalog has **3 entries** (2 CI-maths routines + the house style).

**Applying — copy-on-use (D2).** `use_routine` copies a routine onto a **Lesson**;
`use_formatter` copies a formatter onto a **Course/deliverable**. Both share one
two-phase path: clone the entry's subtree with fresh ids into the active subject's
draft, link it via `usesRoutine`, dry-run returns diff + token + the minted `old → new`
id-map, confirm reuses it. The copy is independent of the library (drift is the accepted
tradeoff).

**Generation reads it, prompts slimmed (#79).** `walk_graph` already surfaces a Course's
`usesRoutine` formatter, so the maths prompts were slimmed: the shared house style
(palette, fonts, page setup, image compression) now lives **only** in the formatter, not
the prompts. Verified live — a generated CI-maths chapter took its palette / typography /
page setup from the applied formatter, with the routine driving structure, no inlined
fallback. (Reading's prompt is untouched — it has no Course yet, so no formatter can be
applied.)

**Surfaced.** `get_capabilities` carries a `catalog` mirror (both scope namespaces,
`canUse` from the same `apply` gate, and the per-namespace edit governance).

## Phase 2 — subject profiles (Step 2a done, in-repo)

The three per-subject adapter behavior modules are **gone**. A subject is now a
declarative `SubjectProfile` (`src/adapters/profile.ts`, a Zod schema whose type
is inferred so the two can't drift) read by **one** generic factory
(`src/adapters/build.ts::buildAdapterFromProfile`). The three subjects ship as
data literals under `src/adapters/profiles/`; the registry (`adapters/index.ts`)
maps `(grade, subject) → profile` and validates every profile at load, so a
malformed one fails loudly at startup rather than as a silent mis-parse in a read
(the design's "runtime validation" risk, pinned by `adapters/__tests__/profile.test.ts`).

The three function-valued adapter bits became **generic mechanisms selected by
data** (D7), so nothing subject-specific stayed as code:

- a deliverable's `classify(filename)` → a `match` spec (`"default"` |
  `{ filenameContainsAny }`); the "default" deliverable matches iff no specific
  one does, reproducing the old `manual = !isLessons` complement;
- `coverageWarnings(graph)` → a list of named rules run by
  `curriculum/coverage.ts::runCoverageRules`. Two new generic rules join the
  existing empty-container / multi-parent shapes: `exactly-one-assessment-child`
  (the bilan rule, with the subject's word — "bilan" — as a `noun` parameter) and
  `single-content-parent` (the axis-scoped multi-parent for a maths lesson's two
  parents);
- reading's `postParse` prune → a named strategy in `curriculum/prunes.ts`
  (`content-reachable-from-roots`, parameterised by `rootKinds`).

The read model is byte-identical — the whole suite (344 tests) stays green,
including the bundle-parse, faithful-re-export, and coverage-integrity suites that
exercise every subject through the new profile path.

**The generic identity reader (done, in-repo).** The profile no longer carries a
per-subject kind table (`roleToKind`/`labelToKind`/`statementTypeToKind`). A node's
`kind` is now read from its **own canonical LC fields** by one generic reader
(`parse-graph.ts::kindOf`), uniformly for every subject: a `LessonGrouping` is named
by its `groupName` (`Chapitre`/`Semaine`/`Jour`), a `StandardsFrameworkItem` by its
`statementType` (`Objectif spécifique`, `Arithmétique`, `Grade`, `Theme`, … —
falling back to `normalizedStatementType` where the source leaves `statementType`
empty), and every content leaf by its LC `label`
(`Lesson`/`LearningComponent`/`Activity`/`Material`). The non-canonical
`metadata.role` sidecar is no longer consulted, and there is no dialect flag — the
NERDC standards-only spine (Grade/Theme/Topic/…) and the Senegal spine both read
their kind from `statementType` the same way.

Senegal's `statementType` is a *domain* rather than a clean structural level, so
its standard kinds read as domains (`Arithmétique`, `Objectif spécifique`, …) for
now; that is cosmetic, and backfilling `statementType` to a structural vocabulary
later needs no code change.

(The `upsert_property` wording-edit tool and its `wordingAliases` surface — which
this reader had briefly kept working through a `normalizedStatementType` fallback —
were subsequently **removed** entirely. A node's text and ordinal are now edited
only through the generic verb `edit_node`; there is no separate
wording tool, and the profile no longer declares a wording surface.)

Two consequences: kinds are now the graph's own words (`Chapitre`, `Objectif
spécifique`, `Lesson`, …), so the coverage/prune specs key on those (and identify a
"standard" by `normalizedStatementType`, not a kind); and, because the old kind
table also acted as an in-scope allowlist, dropping it widens the parsed set for CI
maths (Courses, Materials, derived-frame SFIs and the framework root now parse as
units too). This is harmless downstream — generation reads the raw graph and edges
(`walk_graph`/`get_standards`), not read-kinds; the reading prune still trims its
scaffolding; coverage rules ignore the extra kinds — but it does change the stored
node `type`, so **a re-seed of both subjects is required at rollout** for the live
coverage/write path to match.

**Step 2b (done, in-repo) — the profile is authored config.** The profile records
now live in a **Firestore config layer beside the graph** and are edited through
the same draft/publish curator loop, with the Zod guard running at **authoring
time**. A profile change is finally "no redeploy". (D4.)

- **Storage — a config cell on the pointer doc.** Each `(namespace, slot)` carries
  the profile as opaque JSON in a `configA`/`configB` cell on the pointer doc,
  exactly mirroring the per-slot `meta` stamp. It rides the **same** pointer as
  the graph: `createDraft` copies it into the draft cell, `discardDraft` clears
  it, and the atomic publish flip promotes it — one draft, one publish, one audit
  trail for graph **and** profile (the "shared pointer" decision). `kg-store`
  stays subject-agnostic: it stores and hashes the JSON but never parses it.
- **Resolution follows `KG_SOURCE`.** In `firestore` mode `activateContext` reads
  the published config cell, runs `validateProfile`, and builds the adapter from
  it — so a published profile edit takes effect with no redeploy; a namespace
  seeded before the config layer (no cell) falls back to the in-repo literal until
  re-seeded, and an **invalid** stored profile is refused (activation fails loudly
  rather than mis-parsing). In `bundle`/dev mode the in-repo literal stays the
  source of truth. The seed (`seed:kg-store`) writes the literal into the config
  cell, so the literals are now the seed **source** + bundle fallback + test
  fixtures, not the live read path.
- **Editing — `get_profile` / `edit_profile`.** `edit_profile` is a two-phase,
  curator-gated replace built on the store's `config-flow` (its own token space,
  modeled on the publish flow): the dry-run runs the injected validator — the
  **Zod guard plus a referential check** ("a coverage/deliverable rule names a
  kind no node has") — and blocks a malformed profile with no token; the confirm
  stages the new profile onto the draft. `diff_draft` / `publish_draft` surface a
  staged profile change as `profileDiff`, and the publish token's fingerprint
  folds in the profile hash, so an approver can neither miss nor unknowingly
  promote a profile edit that landed since their dry-run. `get_capabilities`
  carries a `profile` mirror (`canEdit` from the same apply gate).

## Phase 2c — the profile as a "graph guide" the LLM reads

> **Status: increments 1–2 built (in-repo).** (1) The split + the guide surface:
> the profile is a `{ core, guide }` record — a machine `core` the parser/classifier
> consume and an authored markdown `guide` the LLM reads via `get_graph_guide`.
> Reads are unchanged (built from `core`; a legacy flat cell still resolves). (2)
> Coverage-as-prose, **additive**: the guide carries the coverage *expectations* in
> prose and a new **`review_draft`** tool bundles them with the deterministic coded
> warnings + a structural snapshot for the model to reason over — the coded rules
> are **kept** as the automatic backstop (their removal is a later call). Still
> **proposed**: retiring the coded coverage rules once the prose review proves out.
> (Guides are now authored for all three subjects — CI maths, CE1 reading, Nigeria
> maths.) This section is the design; the increment notes are inline below.

The Phase 2b profile is **configuration for deterministic server code** — the
parser, the coverage checker, the deliverable classifier. But the larger part of
"how to interpret this subject's graph" has no home yet: the guidance an
**authoring or generating LLM** needs when it reads and edits the graph through
the generic tools (`walk_graph`, `add_nodes`, `create_edges`, `edit_node`). That
LLM flies largely blind today — it infers a subject's conventions from the graph
and from `CLAUDE.md`. Phase 2c gives it an authored **graph guide**: a markdown
document, per subject, that narrates the ontology, the vocabulary, the intended
hierarchy, and the coverage *intent* in prose.

*The motivating example.* A Senegal maths guide would say: "OS (*Objectif
spécifique*) and OA (*Objectif d'apprentissage*) are both `StandardsFrameworkItem`s
— the same family, standards — distinguished by their `statementType`; the
containment logic is **OA → OS → LearningComponent**; author content by aligning a
`Lesson` to its OS via `hasEducationalAlignment`." Notice that *most of this is
already in the graph* — the LC `label`, the `statementType`, the `hasChild` edges.
The guide's job is not to re-encode it but to **state it where the LLM reliably
reads it**, together with the *intent* the raw edges don't carry (where a new node
belongs, what a valid structure looks like).

### Two readers, one boundary

The design rests on separating who consumes each kind of interpretation:

- **Reader A — deterministic code, on the read hot path.** `parseGraph`/`kindOf`,
  the coverage checker, the deliverable classifier. They run on every read,
  synchronously, and are guarded byte-identical across a re-seed (parity). Code
  cannot read prose; putting an LLM on this path would make reads slow,
  non-deterministic, and token-costed, and would forfeit the parity guarantee. So
  Reader A keeps a **thin, machine-readable core** — and, thanks to the generic
  identity reader (§Phase 2a), that core is already tiny: a few edge names, a
  numbering hint, a prune strategy, plus the deliverable file-match.
- **Reader B — the authoring/generating LLM.** It reaches the graph only through
  tools and prompts, so it can (and should) be guided by **prose**. This is where
  the graph guide lives.

The boundary is the rule: **prose guides the LLM; it never sits on the
deterministic read hot path.** That is also the guide's safety — because reads
don't consume it, a wrong or vague guide can mislead an author but can never break
a read or corrupt the parse (unlike a malformed machine core, which `edit_profile`
still Zod-guards and `activateContext` still refuses).

### The layered profile — increment 1 (built)

The Phase 2b config cell (opaque JSON) now carries a `{ core, guide }` **record**:

- a **`core`** — the thin machine-readable config Reader A consumes
  (`SubjectProfile`), Zod-validated exactly as today; and
- an optional **`guide`** — the authored markdown Reader B reads (length-capped so
  the cell stays under Firestore's doc limit).

Both ride the same draft/publish loop. `get_profile` returns the whole record;
`edit_profile` replaces it (the core Zod-validated, the guide length-checked at
authoring time); **`get_graph_guide`** surfaces just the markdown to the LLM,
exactly as `get_prompt` / `get_terminology` already surface per-subject text (that
substrate exists — `sources/<subject>/PROMPT_*.md`, `terminology.json`, and their
tools). The cell stays opaque to `kg-store`, so this was a payload change, not new
store machinery.

**Backward compatibility is load-bearing:** the phase-2b seed wrote *flat*
`SubjectProfile` cells to the live store. The record reader treats a payload with
no `core` key as a legacy flat core (`{ core: raw }`), so the live server keeps
resolving until re-seeded — no forced re-seed to avoid breakage. A starter
`ci/maths` guide ships in-repo; the other subjects start with no guide.

### What this lets us delete, and what stays code

The **advisory coverage rules** are the prime candidate to move from code into the
guide's prose: they only *warn* (never block) and they are not on the read hot
path, so "each chapter should have exactly one bilan" can become a sentence an LLM
checks when it reviews a draft (on `diff_draft`), retiring the coded rule set. The
parser and the deliverable classifier **stay code** — they are on the hot path. So
phase 2c is not "delete all subject config"; it is "move the part a human
reads-and-reasons-about into prose, and keep the part a machine must execute as a
thin core." That is the honest form of "no per-subject code": the *mechanisms*
stay generic code; the *subject knowledge*, including its interpretation guidance,
becomes authored data — most of it prose.

### Increment 2 — coverage-as-prose, additive (built)

The guide now carries the coverage **expectations** in prose (`ci/maths`: no empty
chapter, one bilan per chapter, one chapter per lesson, every teaching lesson
aligned, chapters contiguous), and a new **`review_draft`** tool bundles them with
the server's deterministic **coded** warnings and a subject-agnostic
`structuralFacts` snapshot (node/edge counts; each container's child-type
histogram per axis + assessment-child count; content multi-parent nodes), plus an
`instruction`. The server never calls an LLM — `review_draft` computes the inputs
and the **calling model** reasons over the facts against the guide, catching the
prose-only expectations the coded rules don't cover (alignment, contiguity). It is
read-only, firestore-mode, and reviewing an open draft is curator/approver-gated.

This is **additive on purpose** (the chosen approach): the coded rules stay as the
automatic, deterministic backstop that warns on every edit / `diff_draft` /
publish. `review_draft` adds an on-demand, richer pass on top. Retiring the coded
rules in favour of prose-only is left as a deliberate later call, once the review
path proves out — deleting a deterministic safety net on the live curator loop is
not something to do blind.

### Open (next increments)

- **Retire the coded coverage rules (deferred).** Once `review_draft` proves out,
  the `core.coverage` rules + `runCoverageRules` + the `coverageWarnings` hook and
  its wiring into edit / `diff_draft` / publish could be deleted, moving those
  expectations to prose-only. Deferred because it removes the deterministic
  auto-warnings from the live loop.
- *Guides authored for all three subjects.* `ci/maths` (two-parent axis + bilan),
  `ce1/reading` (bilingual week→day→session, one-parent, skill-area alignment), and
  `primary-1-3/maths` (standards-only NERDC hierarchy, browse-not-author). Further
  edits go through `edit_profile`, no redeploy.
- *Settled in increment 1:* the field split (`core` = parse descriptor +
  deliverable match + capabilities + coverage-for-now; `guide` = the prose), and
  guide validation (free text, capped; the guard is "it can't break reads" by
  construction — reads never consume it; the `core` keeps its Zod guard).

**Decision (D8):** a **layered profile** — thin machine-readable `core` for the
deterministic parser/classifier + an authored markdown `guide` for the
authoring/generating LLM; prose never on the read hot path. (Chosen over
"MD-only / LLM interprets everything," which would put an LLM on the read path and
lose determinism + parity.)

**Scope-from-Course (deferred follow-up).** The remaining per-subject scope logic
(the reading prune; CI maths keeping its scaffolding out) would collapse into a
single generic mechanism — derive the in-scope set by reachability from the
`Course` root — retiring the prune and the widened-parse concern together. Left as
its own change so it can be reviewed against the parity + faithful-re-export guards.

**Not yet:** the **graph-guide MD layer** (phase 2c below), the MCP **resources**
browse surface (D5 — `list_catalog` / `use_*` / `get_profile` are tools for now),
reading's routine catalog (blocked on its missing content layer), and
re-copy/detach ergonomics.

## The goal

A new subject — a new `(grade, subject)`, or a whole new workspace — should be added
by **authoring data against a running server**, not by writing a TypeScript file and
redeploying. The pedagogy, the formatting, and the per-subject configuration should
all be things a **curator picks and edits**, drawn from **catalogs of reusable
building blocks**, and staged through the normal draft/publish loop.

Two catalogs sit at the centre of this:

- a catalog of **instructional routines** — reusable pedagogical structures ("explicit
  teaching in 5 steps", "structure of a chapter in 6 sections"); and
- a catalog of **formatters** — reusable presentation specs (house palette, fonts,
  `.docx` layout, image-compression rules).

A curator authoring a lesson **picks** a routine from the catalog and a formatter for
the deliverable, rather than hand-writing prose or waiting on an engineer.

### The honest success criterion

The bar is precise, and so is its limit:

- A subject that **fits the mechanisms we already have** needs **zero code and no
  redeploy** — it is authored.
- A subject that introduces a **genuinely new structural rule** (a new way to prune a
  graph, a new coverage constraint) needs a **small, generic extension** to a shared
  mechanism — not a new per-subject adapter.

We are not promising "no code ever." We are promising "no *per-subject* code." That
distinction is the whole design: the *mechanisms* stay code; the *subject content* the
mechanisms run on becomes data.

## Where we already are (why this is cheap)

Most of the hard work is done. An audit of the current adapters found that almost
everything subject-specific has **already** been isolated into declarative
configuration, sitting beside a fully generic engine:

- The parse traversal (`curriculum/parse-graph.ts`), the model loader, and envelope
  detection are subject-agnostic. Each adapter only supplies a small **descriptor**
  (which LC label/role maps to which read *kind*) that the generic parser consumes.
- Nothing in `src/server/` branches on a subject or grade *value* — grade/subject are
  opaque partition keys. The one subject-conditional tool (`suggest_fresh_domain`) is
  gated by a **capability flag**, not a `if (subject === "maths")` check.
- The `InstructionalRoutine` + `usesRoutine` machinery — the substrate this whole note
  builds on — already exists and is live for CI maths. One routine is shared by
  **112** teacher-guide lessons today; that is a catalog entry in all but name.

So a subject's specifics live in a handful of already-declarative places (`descriptor`,
`deliverables`, `capabilities`, `coverageWarnings`) plus the prompt
`.md` files. The remaining work is not to *untangle* subject logic from generic code —
that is done — but to **relocate** those declarations from `.ts` files into authorable
data, and to give a curator a catalog to pick from.

## The catalog model

### One substrate, not two

A **formatter and a routine are the same kind of thing.** This server never renders a
`.docx` — generation is LLM-driven, and the model simply obeys the instructions it is
given (see [CLAUDE.md](../../CLAUDE.md), "Document generation is LLM-driven"). So a
"formatter" is not code that emits a document; it is a **named spec the generator
reads and follows** — exactly like a routine. The two differ only in *what the spec is
about* and *where it attaches*:

| kind | spec is about | maps to bucket | attaches to |
|---|---|---|---|
| `routine` | pedagogical structure (steps, sections, order) | A — logic | a **lesson** (`usesRoutine`) |
| `formatter` | presentation (palette, fonts, layout, images) | B — formatting | a **deliverable** or a **workspace default** |

Both are stored the same way — the `InstructionalRoutine` shape from
[`instructional-routines.md`](instructional-routines.md): a named containment subtree
whose leaves are `Material` nodes carrying the spec text in `Material.content`. A
catalog entry is one such subtree; picking it is an edge to it.

**Decision (D1):** build **one** "reusable spec block" catalog with a `kind` tag
(`routine`, `formatter`, and — later, if it earns its place — `heuristic-pack` for
Bucket-C authoring heuristics). Reuse the routine substrate; do **not** build a
parallel formatter engine.

This also maps cleanly onto the existing A/B/C split: routines carry Bucket A,
formatters carry Bucket B. Bucket C (per-subject authoring heuristics like "invent
misconception distractors" or the Wolof/French bilingual patterns) stays as authored
per-subject prompt text for now — those resist becoming reusable blocks, and forcing
them into the catalog on day one would be over-generalisation.

### Picking an entry: copy it

When a curator applies a catalog entry to a lesson, the entry is **copied** — its whole
subtree (the entry routine, its steps, their Materials) is cloned with fresh ids into
the active subject's graph, and the lesson's `usesRoutine` edge points at the *clone*,
not the library entry. The copy is independent thereafter.

This is settled by where the catalog lives. The library is **shared across every
context** (§scope), so it sits in its own reserved namespace — but the store hydrates
one namespace at a time, edge-validation requires a target in the active graph, and
generation walks only the active graph. A by-reference `usesRoutine` edge from a lesson
to a routine in another namespace would be a **cross-namespace reference the
architecture doesn't resolve** — `walk_graph` wouldn't even surface it. Copying
localizes the reference at pick time: the clone lands in the active graph, so
everything downstream (reads, validation, generation) works with no cross-namespace
machinery. "Shared library" and "no cross-namespace resolution" together *force* copy.

**Decision (D2):** **copy-on-use** (revised from an earlier by-reference proposal). The
accepted tradeoff is **drift** — a later edit to a library entry does **not** reach
copies already made; independence is what the copy buys. (Auto-propagation would
require by-reference, which in turn would require either a single-namespace library —
not shared — or the cross-namespace resolution deferred to a later phase. See §"how
far", and note that cross-subject sharing is arguably more a *formatter* need than a
routine need.)

*Concrete:* a curator picks "Fiche de leçon" for a new lesson → its 5-step subtree is
cloned into that subject, the lesson uses the clone, and the curator can tune the clone
without touching the library or any other lesson.

### Scope: a shared library plus per-workspace entries

Some blocks are generic enough for any subject; some are deeply local.

- **Shared library** — cross-workspace entries any subject may pick. "Explicit
  teaching, 5 steps" is generic pedagogy.
- **Per-workspace entries** — local to one workspace, able to extend or override the
  shared set. "Wolof/French bilingual layout" belongs only to Senegal reading.

**Decision (D3):** support **both**. Cross-subject reuse is the reason a catalog
exists at all; but a workspace must still be able to author blocks no one else sees.
Scope follows the existing namespace convention (workspace as the first segment); a
shared entry lives in a reserved shared namespace the resolver falls back to.

### Attachment differs by kind

- A **routine** attaches per **lesson** via `usesRoutine` (already canonical, already
  live — see the routines note on why per-lesson and not per-`LessonGrouping`).
- A **formatter** attaches per **deliverable**, with a **workspace default** so authors
  don't re-pick the house style on every document. A per-deliverable override handles
  the exceptions.

Same catalog, same storage; the attach point and default behaviour are what the `kind`
selects.

## Where the authored data lives

Two things move into the store: the **content** a curator writes (prompt text, catalog
spec blocks) and the **profile** that configures parsing for a subject (the descriptor,
deliverables, wording map, coverage rules).

**Decision (D4):** **split them by nature.**

- **Authored content → LC graph nodes.** Prompt text and catalog spec blocks are
  genuinely *content* — they belong in `Material.content`, as the routine model already
  does. They ride the existing full-graph store and re-export.
- **Subject profile → a separate, schema-validated config layer** beside the graph.
  Parsing configuration is not curriculum; tangling a parse descriptor into curriculum
  nodes would blur two very different things. It gets its own namespace-keyed config
  record.

Both still flow through the **same draft/publish curator loop**, so both inherit
versioning, `diff_draft`, `preview_generation`, and audit for free — a prompt edit or a
profile change is staged on the draft and published with an atomic pointer flip, just
like a curriculum edit.

## How a curator uses it, and how generation reads it

Two different consumers, two different MCP primitives — each used for what it is good
at:

- **A human curator browses the catalog → MCP resources.** A catalog of named,
  addressable blocks a person picks from is precisely the application-controlled,
  human-selects case that MCP **resources** exist for. The catalog is exposed as a
  resource collection the curator's client can list and reference.
- **Attaching an entry → a tool, in the two-phase loop.** Picking a block and wiring it
  to a lesson/deliverable is a graph mutation; it goes through a normal
  dry-run/confirm tool with a `confirmationToken`, role-gated and audited like every
  other edit.
- **Generation reads the resolved specs → tools, as today.** The generating model is
  *not* a human picking from a menu; it calls tools. It continues to read curriculum
  via `walk_graph`/`get_standards`, which already surface a lesson's `usesRoutine`
  target and its `Material`s. The formatter resolves the same way (deliverable →
  formatter → `Material.content`), composed server-side into the prompt the model
  receives.

**Decision (D5):** **resources for the curator's browse; tools for attach and for
generation.** (This resolves an earlier open question: resources looked premature when
we only considered the *model-driven generation* loop, where a model reliably calls
tools and ignores resources. The *curator's* browse flips it — the picker is a person.)

## The residual logic — generic mechanism, switched by config

Three things are genuine algorithms, not data, and pretending otherwise is where a
refactor like this overreaches:

1. CE1 reading's `postParse` prune (keep weeks → days → sessions);
2. CI maths's coverage rule ("exactly one bilan per chapter"; a lesson's two-axis
   parentage);
3. CI maths's example-domain rotation (storybook variety).

**Decision (D7):** stop at **"generic mechanism, switched by config."** No *subject*
owns code, but the mechanism stays code:

- Coverage becomes a small per-subject **rule set** — `empty-container`,
  `multi-parent`, and `exactly-one-assessment-child` (the bilan rule, expressible now
  that assessment is canonical `educationalUse` data). The maths two-axis exception is
  the one bespoke residue.
- The reading prune becomes a **named generic reachability option** the profile selects,
  not a hand-written closure.
- Domain rotation stays a **capability flag** — it is already cleanly gated and is fine
  as generic code.

We deliberately do **not** build a fully node-authorable pruning language to make one
subject's `postParse` pure data. That is a lot of machinery for a thin residue —
diminishing returns.

## Build order

**Decision (D6):** finish the in-flight routine wiring first, then build outward. Each
phase is independently shippable.

1. **Wire routines into generation, slim the prompts.** Complete the routines note's
   "next phases": generation reads a lesson's `usesRoutine → steps → Material.content`
   (via `walk_graph`, not the removed `buildGenerationContext`) and the Bucket-A
   structural prose is deleted from the prompt files. This *empties* the prompts of the
   logic that is moving to the graph, so later phases extract from a clean surface.
2. **Relocate the subject profile to the config layer.** Move the five declarative
   adapter bits into a schema-validated per-`(grade, subject)` profile record. One
   generic adapter builder reads it; the three per-subject `.ts` files collapse into
   data. **Guard:** a malformed profile must fail *at authoring time* (schema check in
   the two-phase mutation) rather than break parsing for a whole workspace at runtime —
   see Risks.
3. **Build the catalog.** Introduce the `kind`-tagged spec-block catalog, the
   shared/per-workspace scoping, the by-reference-plus-detach semantics, and the
   resource surface for browsing. Factor the duplicated Bucket-A/B prose the audit
   found — the "read the curriculum from the graph" tool workflow, and the shared house
   style (the `#2E7D5E` palette, A4 margins, image-downscale rule pasted across all
   three prompt files) — into shared formatter/routine blocks. Per-subject Bucket-C
   heuristics stay as authored prompt.
4. **Dissolve the residual logic (D7).** Coverage rule set, named prune option; leave
   domain rotation as-is.

After phases 1–3, a lesson's structure, a document's formatting, and a subject's
parsing are all authored data a curator can inspect and edit; the per-subject adapter
files are gone.

## Risks and open questions

- **Runtime vs compile-time validation (phase 2) — addressed.** Moving the profile
  to data moved its failure from `tsc` to authoring time. This is handled: the
  `edit_profile` dry-run runs `validateProfile` (the same Zod guard the load-time
  registry uses) and blocks a malformed profile with no token, and
  `activateContext` refuses an invalid stored profile rather than mis-parsing. A
  light referential check (a rule naming a kind no node has) warns without
  blocking. Full referential validation (e.g. a deliverable's `promptFile` must
  resolve) is a reasonable later addition.
- **Detach drift (D2).** Detached lesson-local copies do not receive later fixes to the
  shared entry — by design, but curators need to *see* that a block is detached and
  which shared version it forked from. The attach record should carry that provenance.
- **`characterConsistency` — removed.** This capability was declared by every
  profile but read nowhere, and its concern (keep the cast + art style consistent
  across a subject's materials) is already handled — better — as **authored prompt
  prose** ("reuse the established characters", the HOUSE ART STYLE block) in every
  generation prompt. Wiring a boolean to gate that prose would re-introduce the
  inlined-house-style-in-code pattern this whole note dismantles; character/art
  consistency is Bucket-B/C and belongs in authored data (prompt today, a formatter
  or routine catalog entry tomorrow), not a code flag. It was deleted rather than
  carried into the config layer, where a curator could toggle a setting that does
  nothing. (`exampleDomainRotation` stays — it gates a real behaviour: the
  `suggest_fresh_domain` / `domain_usage` helper tools.)
- **Scale honesty.** With three subjects and a couple of routines, the catalog earns
  its keep from the *authoring UX* and the multi-tenant direction, not from
  deduplication alone. Keep phase 3's first cut small (the shared house style + the two
  existing routines); resist building a general templating engine for a handful of
  blocks.

## Decisions at a glance

| # | Decision | Chosen default |
|---|---|---|
| D1 | One catalog or two | **One** `kind`-tagged spec-block catalog, reusing the routine substrate |
| D2 | Reference vs copy on pick | **Copy-on-use** (revised from by-reference; forced by a shared cross-namespace library — copy localizes the reference; tradeoff = drift) |
| D3 | Catalog scope | **Both — shipped:** shared `_shared/_catalog` + per-workspace `<ws>/_catalog`; `list_catalog` unions + tags scope; edit gated per-namespace |
| D4 | Where authored data lives | **Content → LC nodes** (catalog = a reserved-namespace routine graph); profile → **separate config layer, shipped** (a config cell on the pointer doc, riding the shared draft/publish loop; `get_profile` / `edit_profile`) |
| D5 | Curator browse surface | **Tool for now** (`list_catalog`); MCP resources deferred. `use_routine` / `use_formatter` attach by copy |
| D6 | Build order | **Routine wiring first → profile to config → catalog → dissolve residue** |
| D7 | Residual per-subject logic | **Generic mechanism switched by config** (no node-authorable prune language) |
| D8 | Profile: config vs guide | **Layered (proposal)** — thin machine-readable `core` for the deterministic parser/classifier (Zod-guarded, on the read hot path) + an authored markdown `guide` the LLM reads; prose never on the read hot path. Advisory coverage migrates to guide prose; parser/classifier stay code |

## Related

- [`logic-in-the-graph.md`](logic-in-the-graph.md) — the guiding principle (graph holds
  the logic; generation is a formatter) this note operationalises.
- [`instructional-routines.md`](instructional-routines.md) — the routine substrate the
  catalog is built on; this note supersedes its "Next phases" framing.
- [`multi-subject-architecture.md`](multi-subject-architecture.md) — the one-generic-parser
  adapter seam whose declarations phase 2 relocates to data.
- [`graph-native-authoring.md`](graph-native-authoring.md) — the content layer routines
  and formatters attach to.
- [`kg-mutations/`](kg-mutations/) — the two-phase mutation + draft/publish loop that
  catalog attach and profile edits flow through.
