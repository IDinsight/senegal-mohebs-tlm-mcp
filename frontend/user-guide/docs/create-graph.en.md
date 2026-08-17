# Create a knowledge graph

The **knowledge graph** is the structure of the curriculum: what pupils must learn, and the material that teaches it, linked together. This structure is what drives the generation of manuals and lesson sheets. This page explains **what a graph is made of** and **how one comes into being**. To fill it in afterwards, see [Build standards and components](build-standards.md).

!!! info "Curators only"
    Creating and editing the curriculum needs the **curator** role (or higher). Anyone can read and view it. Not sure? Ask: "What can I do?"

## The graph has two layers

A helpful picture for everything that follows: the graph stacks **two layers**, tied to each other.

- **The standards** — *what a pupil must master*. This is the stable backbone: the broad domains (e.g. *Arithmetic*), then the precise objectives inside them (e.g. *Count up to 20*). This layer rarely changes.
- **The content** — *what teaches those standards*. The courses, chapters and lessons you write. This layer lives and evolves.

The two layers are **stitched together**: each lesson is **aligned** to the standard it teaches. That link is what lets the tool check the curriculum really covers every objective, and feed the right context when it generates a document.

!!! example "A concrete example"
    The standard says: "The pupil can compare two numbers up to 20."
    The lesson *"Bigger, smaller"* in chapter 3 is **aligned** to that standard: it is the one that teaches it. If one day no lesson teaches that standard, the tool can flag it for you.

## How a graph comes into being

There are two moments to tell apart.

### At the very start: importing a starter graph

When a **new subject** arrives in the system (say, mathematics for a new grade), the starting backbone — the standards framework and its first tree — is **imported** from a file by an administrator or a developer. This is not something done through chat; it is described in [Add a workspace or a subject](admin-developer.md).

Remember this: **the standards framework** (the root of the "standards" layer) enters the system through that import. You do not have to create it yourself.

### After that: you build the structure by chatting

Once the subject is in place, **everything else is built by chatting with Claude** — this is your work as a curriculum expert:

- add **objectives** and **learning components** under the standards → [Build standards and components](build-standards.md);
- create **courses, chapters and lessons**, and align them to the standards → [Add and edit a course and its lessons](courses-lessons.md).

You can even start a **brand-new course** from scratch by chatting (a course is a "root" of the content layer); only the *standards* root depends on the initial import.

## Get your bearings before you build

Before creating anything, take stock of what already exists. Two habits:

> "Give me an overview of this subject."

Claude gives you a **snapshot**: how many standards, courses, lessons, what the starting points ("roots") are, and whether a draft is already open. This is the best place to begin.

> "Show me the structure from this course."

Claude **walks** the graph from a point you name and lists its contents, page by page.

You can also open the **[explorer](explorer.md)** to *see* the published tree visually — handy for getting an overall feel before you touch anything.

!!! note "Nothing is official until it is published"
    Like any curriculum change, what you create here first goes into a **draft** — a separate workspace, invisible to document generation, until an approver publishes it. So you can build in peace. See [Review, publish or discard a draft](review-approve.md).
