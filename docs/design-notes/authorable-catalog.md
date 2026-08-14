# Authorable catalog — subjects as data, curators as authors

> **Status: Live — the routine + formatter catalog is shipped, deployed, and verified
> (2026-08-14).** The catalog (routines and formatters, across a shared and a
> per-workspace scope) runs on the deployed server; the house-style formatter is applied
> to both CI-maths Courses, and a generated chapter was verified to take its style from
> the formatter. Still a **proposal**: the subject-profile **config layer**, the MCP
> **resources** browse surface (D5), reading's routine catalog (blocked on its content
> layer), and re-copy/detach ergonomics. This note extends
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
only through the generic verbs `set_content` / `reposition`; there is no separate
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

**Step 2b (follow-up, not started):** move the profile records into a
Firestore-backed config layer edited through the draft/publish curator loop, with
the same Zod guard running at **authoring time**. Only then is a profile change
"no redeploy"; Step 2a still ships the literals in the container. (D4.)

**Scope-from-Course (deferred follow-up).** The remaining per-subject scope logic
(the reading prune; CI maths keeping its scaffolding out) would collapse into a
single generic mechanism — derive the in-scope set by reachability from the
`Course` root — retiring the prune and the widened-parse concern together. Left as
its own change so it can be reviewed against the parity + faithful-re-export guards.

**Not yet:** Step 2b (above), the MCP **resources** browse surface
(D5 — `list_catalog` / `use_*` are tools for now), reading's routine catalog (blocked on
its missing content layer), and re-copy/detach ergonomics.

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

- **Runtime vs compile-time validation (phase 2).** Today a bad descriptor fails
  `tsc`. Moving it to data moves that failure to runtime/authoring time. This is
  acceptable only with real schema validation on the profile record and a guard in the
  mutation path; treat it as part of phase 2, not a footnote.
- **Detach drift (D2).** Detached lesson-local copies do not receive later fixes to the
  shared entry — by design, but curators need to *see* that a block is detached and
  which shared version it forked from. The attach record should carry that provenance.
- **`characterConsistency` is currently dead.** The audit found this capability is
  declared by every adapter but read nowhere. Decide whether it becomes a real
  generation input (it is the "character consistency" half of the logic-in-the-graph
  principle) or is removed — don't carry it into the config layer unexamined.
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
| D4 | Where authored data lives | **Content → LC nodes** (catalog = a reserved-namespace routine graph); profile → separate config layer (later phase) |
| D5 | Curator browse surface | **Tool for now** (`list_catalog`); MCP resources deferred. `use_routine` / `use_formatter` attach by copy |
| D6 | Build order | **Routine wiring first → profile to config → catalog → dissolve residue** |
| D7 | Residual per-subject logic | **Generic mechanism switched by config** (no node-authorable prune language) |

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
