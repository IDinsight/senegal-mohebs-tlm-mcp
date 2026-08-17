# Generate teaching materials

You can produce two kinds of document for a chapter:

- the **pupil manual**;
- the **lesson sheets** (the teacher's guide).

The tool keeps documents **consistent** (same characters, same terminology, notion coverage) and **varied** where it matters (the example domains — fruits, vegetables… — rotate from one chapter to the next).

## What generation draws on

When you ask for a document, Claude does not start from a blank page: it builds on what has been prepared in the curriculum.

- The **lesson structure** comes from the [instructional routines](routines.md) applied to each lesson.
- The **layout** comes from the [formatter](formatters.md) applied to the course.
- The **content** and the **objectives to cover** come from the [graph](build-standards.md) and its alignments.

In other words: the better the curriculum is prepared, the better — and the more consistent — the produced document.

## How it works

1. **Pick the workspace, grade and subject** (see [Getting started](getting-started.md)).
2. **Ask for the document.** For example:

    > "Generate the pupil manual for chapter 5."
    >
    > "Prepare the lesson sheets for chapter 5."

3. **Claude prepares the context** automatically: the relevant part of the curriculum, characters already used, terminology, the notions to cover, and a suggested example domain that doesn't repeat neighbouring chapters.
4. **Claude drafts the document.**
5. **You approve saving it.** Before the document is saved, a **confirmation request** appears. Nothing is saved until you accept.

<!-- SCREENSHOT: save-confirmation dialog -->

## The save confirmation

!!! warning "Immediate write — no draft"
    Saving a document writes **directly** to the shared space: it is **immediate, with no undo**. The confirmation request states exactly what will be written. Read it, then accept or decline.

    (This is different from curriculum edits, which go through a draft first — see [Review, publish or discard a draft](review-approve.md).)

## Tips

- **Lesson sheets build on the manual.** If you're preparing both, do the manual first.
- **Name the chapter** (its number). You can ask "which chapters exist?" if unsure.
- **Check example variety.** To see which example domains have already been used:

    > "Which example domains were used in recent chapters?"

- **Preview a draft before publishing.** If you are testing a curriculum change, you can see the document it would produce **without publishing anything** — see [Preview](courses-lessons.md#preview-before-publishing).

## Finding a document you already produced

> "List the documents for chapter 5."

Claude tells you what already exists and can give you a download link.
