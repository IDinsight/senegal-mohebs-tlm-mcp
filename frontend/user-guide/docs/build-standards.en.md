# Build standards and components

The **standards** are the backbone of the curriculum: what pupils must learn. This page shows how to enrich them by chatting with Claude — adding objectives, spelling out the **learning components**, and organising it all. To then link lessons to those standards, see [Add and edit a course and its lessons](courses-lessons.md).

!!! info "Curators only"
    Adding and editing go through the **curator** role, and stay in a **draft** until published.

## The vocabulary, in three words

| Term | What it is | Example |
|---|---|---|
| **Domain** | A broad theme that groups objectives | *Arithmetic* |
| **Objective** | A precise learning goal, inside a domain | *Compare two numbers up to 20* |
| **Learning component** | A single, well-defined skill or concept, attached to an objective | *Recognise the "&gt;" symbol* |

Domains and objectives nest like folders and sub-folders. Components are the finest bricks: they **sharpen** an objective by breaking it into concrete know-how.

## Add an objective

Tell Claude what you want to add and **where**:

> "Add an objective 'Compare two numbers up to 20' in the Arithmetic domain."

As always, Claude first shows you **a preview** of what it will create; you **confirm**, and the objective joins the draft.

## Add learning components

A component attaches **to an objective** — it describes a precise skill that objective covers:

> "Under this objective, add the components: 'recognise the &gt; symbol', 'compare two collections', 'order three numbers'."

You can add **several at once**: it's faster and everything lands in the same draft, in a single step to confirm.

!!! tip "Build in batches"
    To build a whole section, describe it in one go: "Create the Geometry domain with three objectives, and two components under each." Claude prepares the lot, shows you the full preview, and only writes after your approval.

## Link a lesson to an objective: alignment

This is the most important link in the graph. To **align** a lesson to an objective is to declare: "this lesson teaches this objective." That is what lets the tool know which objective is covered, and by what.

> "Align the lesson 'Bigger, smaller' to the objective 'Compare two numbers up to 20'."

Alignment runs from the **content to the standard** (from the lesson to the objective), never the other way — it is always the lesson that "points to" the objective it teaches. You can also say whether a lesson **teaches** an objective or **assesses** it (an end-of-chapter test).

!!! warning "Component or objective?"
    A lesson aligns to an **objective**, not to a component. Components exist to *detail* an objective and feed material generation; they are not alignment targets. If you ask to align a lesson to a component, Claude will point you to the parent objective.

## Check your work

Step back at any time:

> "Give me an overview: how many objectives, how many components?"
>
> "Which objectives are taught by no lesson?"
>
> "Which objective(s) is this lesson linked to?"

That last question matters, because simply walking the tree **does not show** alignments: they cut across the graph from edge to edge and are read one lesson at a time.

The **[explorer](explorer.md)** gives you the same information visually: the standards layer and the content layer, with their links.

## Fix and reorganise

You don't only add; you also fix.

| You want to… | Say something like… |
|---|---|
| Fix a title | "Rename this objective to 'Compare numbers up to 50'." |
| Reword an objective's text | "Replace the text of this objective with: …" |
| Move an objective to another domain | "Move this objective to the Measurement domain." |
| Reorder | "Put this objective second in its domain." |

Every fix follows the same rule: **preview → confirm → draft**. Nothing is official before [publishing](review-approve.md).
