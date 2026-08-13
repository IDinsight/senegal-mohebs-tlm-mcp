# Logic in the graph, generation as a formatter

> **Status: Direction — partially realized.** This is the guiding principle behind
> graph-native authoring and the instructional-routine model. Some of it is live
> (content + routines are graph data); the end state — a thin, mostly-formatting
> generation step — is still being built toward. Notes that implement this principle:
> [`graph-native-authoring.md`](graph-native-authoring.md),
> [`instructional-routines.md`](instructional-routines.md).

## The principle

> *"I want to have the guides' logic as much as possible in the graph, and the
> generation to focus on formatting and maybe character consistency."*

The **graph** should hold the pedagogical **logic** of the teaching guides — what a
chapter or a lesson *is*, its structure, and the fixed rules it must obey — as
first-class, inspectable, editable data. The **generation** step should shrink toward
a **formatter**: it renders that authored logic into the deliverable (`.docx`) and
enforces the cross-cutting **consistency** a document needs (recurring characters, a
single art style). It should invent as little pedagogy as possible.

## Why — what's wrong with the status quo

Today a single generation prompt does two unrelated jobs at once. Take
[`PROMPT_generate_chapter.md`](../../sources/senegal/ci/maths/PROMPT_generate_chapter.md):
~60% of it is pedagogical design (what sections a chapter has, what makes a good CI
activity, coverage rules) and ~40% is formatting (fonts, image sizes, the house art
style). Mixing them has three costs:

- **The logic isn't data.** "A chapter ends with a bilan that returns to the amorce"
  is a load-bearing rule, but it lives as prose in one prompt file — not queryable,
  not versioned as curriculum, invisible to the KG explorer, and impossible to reuse.
- **Generation is heavy and non-deterministic.** The model re-derives the same
  structure every run, so two runs of the same chapter can differ in *structure*, not
  just wording.
- **Every subject re-states it.** Reading's prompt and maths' prompt each carry their
  own copy of "how to build a good guide," instead of the structure living once in
  the graph.

Pulling the logic into the graph makes it **authored once, inspected, edited, and
reused**; it makes a generation run **format a fixed structure** instead of
reinventing it; and it moves us toward subjects that are mostly **authored, not
coded**.

## The division of labor

| Concern | Owner | Examples |
|---|---|---|
| **Structure of a guide** | **Graph** | section order (amorce → je retiens → … → bilan); a lesson's explicit-teaching steps; which lessons exist |
| **Fixed pedagogical rules** | **Graph** | "MCQ A/B/C, choices only in the image"; "the bilan covers every non-bilan OS"; "manuel non consommable"; the coverage rule |
| **Curriculum content** | **Graph** | OS text, components, tasks, terminology, alignments |
| **Formatting / layout** | **Generation** | fonts, colours, spacing, page size, image aspect ratios, file-size limits, the house art style |
| **Cross-document consistency** | **Generation** | reusing established **characters**; one art style across a chapter; example-domain variety |
| **Authoring heuristics** | **Generation (prompt)** | *how* to invent good content: misconception distractors, everyday-Senegalese scenes, varying the correct answer letter |

The two "Generation" rows are exactly the user's *"formatting and maybe character
consistency"* — plus the irreducible authoring heuristics below.

## The decision rule — three buckets

For any rule currently in a prompt, ask which bucket it's in:

- **A — Logic.** A fact about what the guide *is* or *must contain*. → **Graph.**
  *"Every non-bilan lesson gets at least one activity."*
- **B — Formatting.** How the output looks on the page. → **Generation (stays in the
  prompt).** *"Activity images are 21:9, 5.25 cm high."*
- **C — Authoring heuristics.** Generative guidance on how to author *well* — it can't
  be reduced to static data because it describes a way of inventing, not a fact. →
  **Generation (stays in the prompt).** *"Distractors should reflect real
  misconceptions."*

Bucket A moves into the graph. Buckets B and C stay with generation. The line
between A and C is the subtle one: a *constraint* ("the question must be answerable by
looking, not remembering") is closer to A; the *craft* of satisfying it ("draw the
reference basket on the left, three candidates on the right") is C.

## The seam: author-into-graph vs generate-from-graph

The key reframe is that today's one prompt becomes **two distinct steps**:

1. **Author into the graph** — an agent (guided by Bucket-C heuristics) writes the
   curriculum content and structure *as graph nodes*: lessons, activities with their
   options and answers, the instructional routine. This is where the pedagogy is
   decided.
2. **Generate from the graph** — a thin step reads the authored subtree and **formats**
   it into a `.docx`, drawing images in the house style and keeping characters
   consistent. It decides layout, not pedagogy.

So Bucket C doesn't disappear — it **relocates** from the document-generation step to
the graph-authoring step. Generation is left with B (formatting) and the consistency
concerns.

## What "generation focuses on formatting and character consistency" means concretely

After the shift, a generation run should:

- **read** the relevant subtree from the graph (structure + content + the routine's
  section specs);
- **lay it out** per the formatting rules (Bucket B);
- **draw images** in the fixed house art style, reusing the established **characters**
  and rotating example domains for variety;
- **not** decide section order, coverage, or question design — those are read from the
  graph, not invented.

## The honest floor — what generation keeps

This is "as much as possible," not "everything." Generation permanently owns:

- **Formatting/layout and image production** — inherently about the artifact, not the
  curriculum.
- **Character/art consistency** — a cross-document concern that isn't a property of any
  single curriculum node.
- **The Bucket-C authoring heuristics** — even relocated to the authoring step, these
  stay as prompt guidance, because "invent a good distractor" is not static data.

The target isn't a zero-intelligence formatter; it's a step that **formats authored
logic and keeps a book looking like one book**, rather than one that re-derives the
pedagogy each time.

## Related

- [`instructional-routines.md`](instructional-routines.md) — the mechanism that puts a
  guide's structure (Bucket A) into the graph as `InstructionalRoutine` subtrees.
- [`graph-native-authoring.md`](graph-native-authoring.md) — the content layer
  (chapters/lessons/activities as graph data) that generation reads.
