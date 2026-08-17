# Reference

## Who can do what

Roles are granted **per workspace**: you can be a curator here and a plain reader elsewhere.

| Action | No role | Curator | Approver | Admin | Super admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Read the curriculum, generate materials | ✅ | ✅ | ✅ | ✅ | ✅ |
| Explore the graph (read-only) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Prepare changes (draft) | — | ✅ | ✅ | ✅ | ✅ |
| Discard a draft | — | ✅ | ✅ | ✅ | ✅ |
| **Publish** a draft | — | — | ✅ | ✅ | ✅ |
| Manage the workspace's members | — | — | — | ✅ | ✅ |
| Create / delete a workspace | — | — | — | — | ✅ |
| Edit a **shared** catalog entry | — | — | — | — | ✅ |

A catalog entry specific to a workspace (routine, formatter) is edited by a **curator** of that workspace; a **shared** entry (common to all programmes) is reserved for the **super admin**.

To find your role: ask Claude "**What can I do?**".

## The two kinds of confirmation

| You do… | Effect | Safety net |
|---|---|---|
| **Save a document** | Written **immediately**, no undo | The confirmation states what will be written |
| **Edit the curriculum** | Goes into a **draft** first | Nothing is official before an approver **publishes** it |

Either way, nothing happens without your confirmation.

## Short glossary

| Term | Meaning |
|---|---|
| **Workspace** | The container for a programme (e.g. *Senegal*). It owns the curriculums and determines roles. |
| **Grade / subject** | The working scope inside a workspace (e.g. *CI / mathematics*). You work on one at a time. |
| **Knowledge graph** | The structure of the curriculum: the standards, the content, and their links. |
| **Standard** | What a pupil must learn. The stable layer of the graph (domains and objectives). |
| **Domain** | A broad theme grouping objectives (e.g. Arithmetic, Geometry). |
| **Objective** | A precise learning goal, inside a domain. It is the target of an alignment. |
| **Learning component** | A single, fine-grained skill attached to an objective; used to detail it. |
| **Alignment** | The link declaring that a lesson **teaches** (or **assesses**) an objective. Runs from content to standard. |
| **Course** | The root of a document (e.g. the pupil manual, the teacher's guide). |
| **Chapter** | A grouping of lessons; depending on the subject: chapter, unit, or week. |
| **Lesson** | The unit of work: you align it to an objective and apply a routine to it. |
| **Instructional routine** | A reusable lesson-structure template, stored in the catalog. Applies to a lesson. |
| **Formatter** | A formatting instruction (palette, type, layout, illustrations). Applies to a course. |
| **Catalog** | The library of routines and formatters, with a shared shelf and one per workspace. |
| **Pupil manual** | The document for the pupil. |
| **Lesson sheets** | The teacher's guide. |
| **Draft** | A set of pending changes, not yet official. |
| **Publish** | Make the draft official — generation then uses it. |
| **Assessment (bilan)** | The end-of-chapter test. |
| **Explorer** | The read-only web page for viewing the published curriculum. |

## Need help?

- For an access or account problem → the **administrator** of your workspace.
- To add a subject or a workspace → see [Administration & development](admin-developer.md).
- To find out what you can do → ask Claude "What can I do?".
