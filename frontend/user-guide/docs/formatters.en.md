# Create formatters

A **formatter** describes the **appearance** of a document: its colour palette, its typography, its page layout, the style of its illustrations. It is a formatting instruction, written once and applied to a whole course, so every produced document looks alike.

!!! info "An instruction, not an engine"
    The tool never builds a `.docx` itself: generation, driven by Claude, writes the document. A formatter is therefore not a layout program — it is **a set of instructions that generation reads and follows**. Exactly like a routine, but on the *form* side rather than the *pedagogy* side.

## Three concrete formatters

| Formatter | What it fixes | Reach |
|---|---|---|
| **MOHEBS house style (docx)** | Palette, typography (e.g. Calibri, body 11–12 pt), page setup, image compression | Shared — any `.docx` |
| **Art style (images)** | The look of illustrations: flat 2-D vector, Senegalese textbook style, character consistency | Shared — illustrated subjects |
| **Illustration layout — CI maths** | Image formats, activity-panel layouts, answer-badge colours (A red / B blue / C green), display sizes | Workspace — subject-specific |

!!! tip "Formatters stack"
    A specific formatter (the maths illustration layout) **sits on top of** the shared ones (the house style, the art style). The general sets the common tone; the specific adds the rules proper to the subject.

## The catalog: the same library as routines

Formatters and [instructional routines](routines.md) share the **same catalog** and the **same two shelves**:

- **Shared** — common to all programmes, reserved for the **super administrator**;
- **Workspace** — specific to your programme, editable by its **curators**.

To browse and read the catalog:

> "What's in the catalog?"
>
> "Show me the detail of the 'MOHEBS house style' formatter."

## Apply a formatter to a course

Unlike a routine (which applies to a *lesson*), a formatter applies to a **course** — the root of the document to produce:

> "Apply the 'MOHEBS house style' formatter to this course."

Generation of that course will then follow the formatting instruction. As with a routine, applying it creates an **independent copy** attached to the course: a later edit to the catalog formatter does not flow back to courses already served.

## Create or edit a formatter

You write and tweak it **by chatting**, and everything goes into a **draft**:

> "Create a formatter 'Revision-sheet style': …"
>
> "In the house style, set the body font to 12 pt."

A formatter's content is **instruction text**: describe precisely what generation must respect (colours, fonts, sizes, margins, image style…). The clearer the instruction, the more consistent the result.

!!! info "Who can edit what"
    A formatter on the **workspace** shelf is edited by a **curator** of that workspace. A **shared** formatter is reserved for the **super administrator**, since it serves all programmes.

!!! note "A useful detail if you inspect the graph"
    In the explorer, the link attaching a formatter — like the one attaching a routine — carries the same technical name (`usesRoutine`). That's expected: routines and formatters rest on the same mechanism. Only the use differs (one on a lesson, the other on a course).
