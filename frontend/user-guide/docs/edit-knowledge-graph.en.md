# Edit the knowledge graph

The **knowledge graph** is the structure of the curriculum: the **domains**, **chapters** and **lessons**, and how they fit together. This structure is what drives the generation of teaching materials.

!!! info "Curators and approvers only"
    Only **curators** and **approvers** can edit the curriculum. If you're unsure of your role, ask: "What can I do?"

## The most important point: everything goes through a draft

Your changes **do not become official immediately**. They collect in a **draft**:

- You (or other curators) make a series of changes → they stack up in the draft.
- **Nothing reaches document generation until an approver publishes the draft** (see [Review & approve](review-approve.md)).

That's your safety net: you can work freely, and everything is reviewed before it becomes official.

## Every change happens in two steps

1. You ask for the change → Claude shows you **a preview** of what would change (nothing is applied yet).
2. You **confirm** → the change is added to the draft.

<!-- SCREENSHOT: preview of a change before confirmation -->

## Two families of edits

### Fix a title or a text

For example:

> "Change the title of chapter 3 to 'Decimal numbers'."
>
> "Fix this lesson's objective: …"

### Restructure chapters and lessons

| You want to… | Say something like… |
|---|---|
| Add a lesson to a chapter | "Add a lesson '…' to chapter 5." |
| Add a chapter | "Create chapter 26 'Decimal numbers' with two lessons: …" |
| Move a lesson | "Move this lesson to chapter 6." |
| Split a chapter | "Split chapter 5 from lesson … into a new chapter." |
| Renumber a chapter | "Renumber chapter 3 to 26." |

!!! tip "Chapter numbers"
    To add or renumber, the target number must be **free** (append at the end or fill a gap). To insert a chapter in the middle and shift the others, do it explicitly, step by step.

## Check your current draft

> "Show me the pending changes."

Claude shows all the draft's changes (the "approver's view"). You can keep editing, or hand off for [review and publishing](review-approve.md).

## Warnings, not blocks

Some situations trigger a **warning** without stopping the save — for example a chapter with no lessons, or a chapter with no end-of-chapter assessment. That's fine mid-edit; the approver takes it into account when publishing.

Conversely, anything that would break the structure (a lesson attached to nothing, say) is **refused** outright.
