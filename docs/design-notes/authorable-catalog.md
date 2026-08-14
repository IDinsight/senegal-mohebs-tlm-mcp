# Authorable catalog — subjects as data, curators as authors

> **Status: Proposal — direction agreed, not yet built.** This note sets a target
> and a build order; no code implements it yet. It extends
> [`logic-in-the-graph.md`](logic-in-the-graph.md) and
> [`instructional-routines.md`](instructional-routines.md) with a curator-facing
> layer, and it revises the "Next phases" of the routines note (which still names the
> since-removed `buildGenerationContext`). Decisions recorded here are defaults chosen
> on 2026-08-14; revisit them before implementing each phase.

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

So a subject's specifics live in five already-declarative places (`descriptor`,
`deliverables`, `capabilities`, `wordingAliases`, `coverageWarnings`) plus the prompt
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

### Picking an entry: reference, with an escape hatch

When a curator picks a catalog entry for a lesson, the lesson **points at the shared
entry** — it does not get a private copy. This is already how the graph works: 112
lessons share one routine node, so fixing a typo in that routine fixes it everywhere
at once. That is the behaviour we want: DRY, consistent, edit-once.

The failure mode of pure by-reference is that a curator can't tweak *one* lesson
without changing all of them. So we add a **"detach to customize"** action: an explicit
fork that clones the shared entry into a lesson-local copy, after which edits to that
lesson stay local. This is the component-instance-override pattern — reference by
default, private copy only when someone deliberately asks for one.

**Decision (D2):** **by-reference by default, plus explicit detach-to-customize.** The
extra machinery (a fork operation, and marking an attachment as detached) is worth it:
it is the difference between a catalog people trust to edit and one they are afraid to
touch.

*Concrete:* fix a wording error in the shared "explicit teaching" routine → every
attached lesson gets the fix, except any a curator had explicitly detached to hold a
local variant.

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
  via `get_course`/`get_standards`, which already surface a lesson's `usesRoutine`
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
   (via `get_course`, not the removed `buildGenerationContext`) and the Bucket-A
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
| D2 | Reference vs copy on pick | **By-reference + explicit detach-to-customize** |
| D3 | Catalog scope | **Shared library *and* per-workspace entries** |
| D4 | Where authored data lives | **Content → LC `Material` nodes; profile → separate config layer** (both via the curator loop) |
| D5 | Curator browse surface | **Resources to browse; tools to attach and to generate** |
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
