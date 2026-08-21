# Instructional routines — pedagogical logic as graph data

> **Status: Current — partially implemented and live.** The model exists for both
> deliverables: the **teacher guide's** "fiche de leçon" (5 explicit-teaching steps)
> via PR #65/#66, and the **pupil manual's** "structure d'un chapitre" (6 sections)
> via this PR. Both are **data-only** — the parser ignores the labels, so curriculum
> reads are byte-identical and no server redeploy is needed. Feeding the routine into
> generation, and slimming the prompts, are the **next phases** (see the end of this
> note). CI/maths only so far; CE1 reading has no routine yet.

## Why this exists — the direction

Today a single generation prompt does two jobs at once: it **authors** the
pedagogical design (what a good chapter/lesson looks like) *and* **formats** the
output (`.docx` layout, images). We want to pull the first job out of the prompt
and into the graph, so that:

- **the graph holds the guide's logic** — the instructional structure and the
  fixed pedagogical rules — as first-class, inspectable, editable data; and
- **generation shrinks toward a formatter** — it renders authored graph content
  and keeps characters/art consistent, keeping only the *light authoring
  heuristics* that resist being turned into data.

Concretely we sort every rule in a prompt into three buckets:

| Bucket | Example | Home |
|---|---|---|
| **A — logic** | section order; "bilan returns to the amorce"; MCQ A/B/C; coverage rule | **the graph** (this note) |
| **B — formatting** | fonts, colours, aspect ratios, image embedding, house art style | the prompt (generation's job) |
| **C — authoring heuristics** | "invent misconception distractors", "pick an everyday-Senegalese scene", "vary the correct letter" | the prompt (can't be static data) |

An `InstructionalRoutine` subtree is how Bucket A lives in the graph.

## The model

A routine is a small containment subtree in **canonical Learning Commons** — no
subject vocabulary, no new node/edge types:

```
InstructionalRoutine (parent)          ← metadata.summary = cross-cutting rules
  ─hasPart→ InstructionalRoutine (step, position 1)
              ─hasPart→ Material       ← Material.content = the step's FR spec
  ─hasPart→ InstructionalRoutine (step, position 2)
              ─hasPart→ Material
  … one step per section …
```

and it is **applied** to the content it governs by a `usesRoutine` edge:

```
Lesson ─usesRoutine→ InstructionalRoutine (parent)
```

All three edge/label choices are canonical LC (`InstructionalRoutine`;
`InstructionalRoutine —hasPart→ InstructionalRoutine`/`Material`; `usesRoutine`
from `Course`/`Lesson`/`Activity`) — see
[`docs/reference/learning-commons/`](../reference/learning-commons/). Conventions
that make a routine round-trip and render consistently:

- **`metadata.role`** — `instructional-routine` on the parent/steps,
  `instructional-routine-material` on the leaves.
- **The parent's `metadata.summary`** carries the rules that aren't tied to one
  section (e.g. "French only", the answer-by-looking golden rule, "manuel non
  consommable"). The per-section rules live in each step's `Material.content`.
- **Steps are ordered** by `position`; the leaf carries the actual prose as HTML
  in `Material.content` (French, teacher/author-facing).

### Why the nodes are "non-spine"

The parser (`curriculum/parse-graph.ts`) maps only the labels it recognises into
read *kinds* (chapter, lesson, week, …). `InstructionalRoutine` is **not** mapped,
so a routine subtree is stored and re-exported verbatim but never enters the
curriculum read model. That is what lets us add a routine as a pure **data-only**
change: curriculum reads stay byte-identical (guarded by the read-projection
goldens), and the full-graph store still round-trips (guarded by
`curriculum/__tests__/faithful-reexport.test.ts`). The routine surfaces only where the graph
is shown raw — the KG explorer's by-label view, and folded under each `usesRoutine`
source in the curriculum view.

## The two routines today (CI/maths)

### Teacher guide — "Fiche de leçon" (PR #65/#66)

The 30-minute explicit-teaching lesson, as **5 ordered steps** with `timeRequired`
(Déclencheur PT4M → Modelage PT8M → Nous faisons PT8M → Tu fais PT10M →
Objectivation PT5M). Each step's `Material.content` holds the teacher's consigne,
including the three lesson-type variants (first lesson / intermediate / bilan).
Applied by `usesRoutine` from each of the **112 Teacher's-Guide lessons**.

### Pupil manual — "Structure d'un chapitre" (this PR)

The chapter template of the pupil book, as **6 ordered sections**:

| pos | section | what its `Material.content` specifies |
|---|---|---|
| 1 | Titre du chapitre | child-friendly FR title; optional domain subtitle |
| 2 | Situation d'amorce | master scene (fixes characters/objects/decor); ≤ ~5 countable; 3–4 warm-up questions spanning the chapter; the scene the bilan points back to |
| 3 | Je retiens | first-person boxed summary, 3–5 bullets, key terms bold |
| 4 | Consigne générale | the fixed sentence, verbatim |
| 5 | Activités | one per non-bilan lesson (two where the OS supports); MCQ A/B/C shown **only in the image**; term in title, concrete stem; coverage judged per lesson |
| 6 | Bilan | review on the amorce scene; covers every non-bilan OS; no image of its own |

No `timeRequired` (a printed manual isn't timed). Applied by `usesRoutine` from each
of the **25 Student's-Book container lessons** (`metadata.role: studentBookLesson`).

**Why per-lesson, not per-chapter or per-Course.** `usesRoutine` may originate from
`Course`/`Lesson`/`Activity` — **not** from a `LessonGrouping` — so attaching per
chapter (a `LessonGrouping`) would be off-canon. Between the two canonical options,
attaching to the 25 container **lessons** (rather than one edge from the
Student's-Book Course) mirrors how the teacher-guide routine attaches per lesson, and
makes the routine nest under each lesson in the explorer. (The teacher guide's
original #65 Course-level edge was deliberately moved to per-lesson in #66 for the
same reason.)

## How it was authored (data-only recipe, reproducible)

Same shape as #65:

1. Mint the nodes/edges deterministically (UUID5) and splice them onto the *source*
   graph `sources/senegal/ci/maths/knowledge_graph.json`. New records copy an
   existing routine node's field conventions verbatim (labels, `metadata.role`,
   `license`/`attributionStatement`, edge `sourceEntity`/`targetLabels`…), so they
   round-trip.
2. Bump the `faithful-reexport.test.ts` maths counts by the deltas and run the
   suite — the round-trip + read goldens prove additions-only and byte-identical
   reads.
3. Re-seed Firestore (`node scripts/seed-kg-store.mjs ci maths`) and verify
   (`parity:kg-store -- --live`). **No Cloud Run deploy** — data-only, parser
   unchanged. See [`rollout`](../../.claude/skills/rollout/SKILL.md).

Deltas for the manual routine: **+13 nodes** (1 parent + 6 steps + 6 Materials),
**+37 edges** (12 `hasPart` + 25 `usesRoutine`) → CI/maths **770 nodes / 1304 edges**.

Because the nodes are canonical and copy an existing node's identity, the same
subtree can equally be authored through the generic `add_node` + `edit_node`
verbs rather than a splice script — the splice is just faster for a one-shot bulk add.

## Next phases (not in this PR)

> **Superseded framing.** The `buildGenerationContext` adapter method named below has
> since been removed — generation now reads the graph directly through
> `walk_graph` / `get_standards`, which already surface a lesson's `usesRoutine` target
> and its `Material`s. These two phases are now phase 1 of the broader
> [`authorable-catalog.md`](authorable-catalog.md) plan, which turns routines (and
> formatters) into a curator-picked catalog.

1. **Feed the routine into generation.** Have generation resolve
   `usesRoutine → steps → Material.content` (via `walk_graph`, not the removed
   `buildGenerationContext`) and read the section specs from the graph instead of from
   prompt prose.
2. **Slim the prompts.** Once (1) lands, delete the Bucket-A prose from
   `PROMPT_generate_chapter.md` / `PROMPT_generate_lessons.md`, leaving Bucket B
   (formatting/art) and Bucket C (authoring heuristics).

Until (1) lands, the routine is inert with respect to generation — it documents and
stages the logic in the graph, but the prompts are still the source of truth for a
generation run.

## Related

- [`graph-native-authoring.md`](graph-native-authoring.md) — the content layer these
  routines attach to (chapters/lessons/activities as graph data).
- [`docs/reference/learning-commons/`](../reference/learning-commons/) — canonical
  node/edge definitions for `InstructionalRoutine` and `usesRoutine`.
