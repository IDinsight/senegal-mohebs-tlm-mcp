# Add and edit a course and its lessons

This is where the teaching **content** gets built: the courses, their chapters, and the lessons. You write them, organise them, and **link** them to three things: the standards they teach, the **instructional routines** that give lessons their structure, and the **formatters** that decide the layout. Once this content is in place, it feeds [document generation](create-materials.md).

!!! info "Curators only"
    These edits go through the **curator** role and stay in a **draft** until published. Nothing reaches generation before it is published.

## The "content" layer at a glance

```
Course  →  Chapter (grouping)  →  Lesson  →  Activities, materials
```

- A **course** is the root of a document — for example *the pupil manual* or *the teacher's guide*.
- A **chapter** (a grouping) gathers lessons; depending on the subject it may be called a chapter, a unit, or a week.
- A **lesson** is the unit of work: it is what you align to an objective and apply a routine to.

## Create a course, a chapter, a lesson

Just describe what you want, and where:

> "Create a chapter 26 'Decimal numbers' at the end of the pupil manual."
>
> "Add a lesson 'Add two decimals' to chapter 26."

You can describe it all at once — Claude prepares the lot, shows the **preview**, and only writes after your **confirmation**:

> "Create chapter 26 with three lessons: …, …, …"

!!! tip "Chapter numbers"
    To add or renumber, aim at a **free** number (add at the end, or fill a gap). To insert a chapter in the middle and shift the others, do it explicitly, step by step.

## Edit and reorganise

| You want to… | Say something like… |
|---|---|
| Fix a title | "Rename chapter 3 to 'Decimal numbers'." |
| Edit a lesson's text | "Replace the content of this lesson with: …" |
| Move a lesson | "Move this lesson to chapter 6." |
| Reorder | "Put this lesson first in the chapter." |
| Delete | "Delete this lesson." (whatever depends on it is removed with it) |

Moving a lesson does not renumber everything in cascade: belonging to a chapter is a link, not a fixed number.

!!! note "A lesson can have two homes"
    In mathematics, one lesson may belong **both** to a chapter (the content axis) and to a week (the schedule axis). This is intentional. Moving the lesson along one axis leaves the other intact — say which one you mean if there is any doubt.

## Link a lesson to the standards

A lesson only makes full sense when **linked to the objective it teaches**. That is **alignment**, described in detail in [Build standards and components](build-standards.md):

> "Align this lesson to the objective 'Compare two numbers up to 20'."

To check what a lesson teaches:

> "Which objective is this lesson linked to, and which components does it cover?"

## Apply an instructional routine to a lesson

A **routine** is a reusable teaching template — for example the five steps of a 30-minute lesson sheet. You **apply it to a lesson** to give it structure:

> "Apply the 'Lesson sheet' routine to this lesson."

Applying a routine makes an **independent copy** attached to your lesson: later tweaks to the original routine do not change it. To create or edit the routines themselves, see [Create instructional routines](routines.md).

## Apply a formatter to a course

A **formatter** describes the **layout** of the produced document — palette, typography, page setup, illustration style. You **apply it to the course** (the root of the document), and generation follows it:

> "Apply the 'MOHEBS house style' formatter to this course."

As with a routine, applying it creates an independent copy attached to the course. To create or edit formatters, see [Create formatters](formatters.md).

## Preview before publishing

Before handing over to the approver, you can **see the result** of your draft without publishing anything:

> "Show me the pending changes." *(the draft in detail)*
>
> "Preview the manual for this course from the draft." *(the document it would produce)*

The preview stays **isolated**: it writes nothing to the official space and does not appear in the list of produced documents. When you are happy with everything, move to [Review, publish or discard a draft](review-approve.md).
