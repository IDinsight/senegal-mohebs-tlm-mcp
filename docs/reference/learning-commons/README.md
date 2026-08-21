# Learning Commons (LC) ontology — canonical reference

A local, quick-reference copy of the **Learning Commons Knowledge Graph** schema —
the node types (data model per label) and the relationship types — so we can check
our graph against canon without a round-trip to the website, and keep every edit
**canonical**.

> **Source & license.** Captured verbatim (property tables, relationship endpoints,
> enums) from the Learning Commons docs, <https://docs.learningcommons.org/knowledge-graph/schema-reference/>.
> LC **data** is **CC BY 4.0** (credit: 1EdTech — state standards; Achievement
> Network — learning components; Student Achievement Partners — learning
> progressions, CC0). LC **code** is MIT. This mirror is for internal reference;
> the website is authoritative — if it and this folder disagree, the website wins,
> and a PR should reconcile this copy. Schema last checked: **2026-08-13**
> (LC schema dated 2025-09-23).

## Files

- [`node-types.md`](node-types.md) — the **data model per node type**: every LC
  label, its properties (type + cardinality), and the relationships it participates in.
- [`relationships.md`](relationships.md) — **all relationship possibilities**: every
  edge type, its legal source→target node types, semantics, and the shared
  relationship properties.
- [`enums-and-formats.md`](enums-and-formats.md) — every enumeration and its allowed
  values (`NormalizedStatementTypeENUM`, `EducationalUseENUM`, …) plus formats.

## The two trees (the one thing to internalise)

LC is **two hierarchies that connect by alignment**, never by mixing their edges:

```
STANDARDS tree                        CONTENT tree
(nested by hasChild)                  (nested by hasPart)

StandardsFramework                    Course
  └ hasChild → StandardsFrameworkItem   └ hasPart → LessonGrouping
      └ hasChild → …FrameworkItem            └ hasPart → Lesson
                                                   └ hasPart → Activity
LearningComponent                                       └ hasPart → Material
  └ supports → StandardsFrameworkItem

          content ── hasEducationalAlignment ──▶ StandardsFrameworkItem
          (Course/LessonGrouping/Lesson/Activity/Assessment/Material → SFI)
```

- **`hasChild`** nests the **standards** tree ONLY: `StandardsFramework→SFI` or
  `SFI→SFI`. It is **never** a content edge — a Lesson/Activity/LessonGrouping can
  **not** be a `hasChild` target.
- **`hasPart`** nests the **content** tree ONLY, and each label's legal children are
  fixed (see `node-types.md`): `Course` holds `LessonGrouping`/`Material`;
  `LessonGrouping` holds `Lesson`/`LessonGrouping`/`Assessment`/`Material`; `Lesson`
  holds `Activity`/`Assessment`/`Material`; `Activity` holds `Material`.
- **`supports`** attaches a `LearningComponent` to its `SFI`.
- **`hasEducationalAlignment`** is the ONLY bridge from content → standards.
- **`buildsTowards` / `relatesTo`** are progression edges **between `SFI`s** (SFI↔SFI).

## How this project maps onto LC

Enforced in code — keep these in sync with canon:

| Concern | Where | Canonical rule |
|---|---|---|
| Content vs standards labels, containment edge per label | [`src/kg-recipes/lc.ts`](../../../backend/src/kg-recipes/lc.ts) (`containmentEdgeFor`, `CONTENT_LABELS`, `STANDARDS_LABELS`) | content→`hasPart`, standards→`hasChild`, LearningComponent→`supports` |
| Alignment edge | `lc.ts` (`ALIGNMENT_EDGE`) | content→SFI via `hasEducationalAlignment` |
| Parser folds containment + alignment | [`src/curriculum/parse-graph.ts`](../../../backend/src/curriculum/parse-graph.ts) | `hasChild`+`hasPart` are containment; `supports`+`hasEducationalAlignment` are attachment |
| Explorer categories/colours by LC label | [`src/kg-export.ts`](../../../backend/src/kg-export.ts) (`LABEL_DEFS`) | one colour per LC label |
| Non-canonical extras live in a sidecar | `metadata.*` on every node | see below |
| Document / rendering layer (non-canonical labels + `covers` edge) | [`docs/design-notes/teaching-learning-materials.md`](../../design-notes/teaching-learning-materials.md) | LC defines no document/formatter node — intentional extension (deviation 7) |

**Our `metadata` sidecar is an extension, not canonical LC.** LC defines no
`metadata` property. We carry our non-canonical extras there verbatim (extraction
provenance, reading's palier/genre, `metadata.role`, `metadata.en.*` translations,
`metadata.illustratesComponent`, `metadata.sourceLesson`). Rationale:
[`docs/design-notes/canonical-lc-migration.md`](../../design-notes/canonical-lc-migration.md).

## Known deviations from canon (revisit when convenient)

These are places our CI/maths graph is deliberately or historically **off-canon**.
Documented so they don't get mistaken for canon:

1. ~~**Weeks are modelled as `StandardsFrameworkItem` (role `week`).**~~ **RESOLVED**
   — weeks are now **`LessonGrouping`** (role `week`) with `Course ─hasPart→ week
   ─hasPart→ Lesson`, all canonical. (The `role "week"` sidecar still distinguishes
   them from chapters, which are `role "subtopic"`.)
2. ~~**RECE illustrative activities hang off their frame via `SFI ─hasChild→
   Activity`.**~~ **RESOLVED** — the 104 off-canon `hasChild` edges were dropped; each
   illustrative Activity keeps its `hasEducationalAlignment` to its family SFI (the
   canonical content→standard bridge) and its `metadata.illustratesComponent`
   pairing. No `hasChild` targets content anywhere now.
3. ~~**`buildsTowards` between chapters (`LessonGrouping→LessonGrouping`).**~~
   **RESOLVED** — converted to canonical **`hasDependency`** (`dependent hasDependency
   prereq`, i.e. the edges were reversed since `hasDependency` is the opposite
   direction of `buildsTowards`). The parser reads it reversed into the same
   `buildsTowards`/`buildsFrom` read model (`parse-graph.ts` `dependencyEdge`).
4. ~~**Content groupings carry SFI-flavoured fields.**~~ **RESOLVED (ci/maths)** —
   `statementType`/`normalizedStatementType` stripped from the 48 maths content
   `LessonGrouping`s; grouping-ness is now label-driven (`parse-graph.ts`
   `GROUPING_LABELS`, `deriveTemplate`) and chapters are keyed off the canonical
   `groupName`. (CE1 reading's content groupings still carry them — the parser is
   backward-compatible, so it's a safe follow-up when reading is next re-seeded.)
5. **Bilan via `educationalUse: "Assessment"` on a `Lesson`** rather than a dedicated
   **`Assessment`** node. `educationalUse` does allow `Assessment` (it's in
   `EducationalUseENUM`), so this is valid-ish, but LC also has a first-class
   `Assessment` label we don't use.
6. **`metadata.illustratesComponent`** encodes an Activity→LearningComponent link
   that **has no canonical edge** (LC defines none). This is an intentional sidecar
   extension, surfaced display-only by the explorer.
7. **The document / rendering layer — non-canonical labels + edge.** Documents and
   their formatting are modelled with **labels LC does not define**:
   `TeachingLearningMaterial` (the deliverable — a new graph root), `DocumentSection`
   (the document's own optional spine — a page/section), `Formatter` (a rendering
   concern), and `FormatterSpec` (one rule within it), nested
   `TLM ─hasPart→ DocumentSection` and `─hasPart→ Formatter ─hasPart→ FormatterSpec`;
   plus a **non-canonical edge** `covers` binding a document-thing to the curriculum it
   renders, at two granularities: `TeachingLearningMaterial ─covers→ Course` (coarse
   scope) and `DocumentSection ─covers→ Lesson`/`LessonGrouping`/`Activity` (the
   authoritative per-section mapping; a section with no `covers` target is
   document-native front-matter). Intentional extensions — a document is a *sibling
   artifact* of the curriculum, so it can be neither a canonical `Material` (which may
   only sit *inside* the content tree via `hasPart`) nor a `Course` (a unit of study,
   not an artifact). The document's own generation logic rides the sidecar as
   **`metadata.assemblyGuide`** (authored markdown). Design:
   [`docs/design-notes/teaching-learning-materials.md`](../../design-notes/teaching-learning-materials.md).
   *(This replaces the earlier stopgap of modelling a **formatter** as an
   `InstructionalRoutine` attached to a `Lesson` — off-canon because a formatter is a
   rendering concern, not an instructional routine, so the `InstructionalRoutine` label
   was the wrong home for it. The `usesRoutine` **edge** from a `Lesson` is **not** the
   problem and never was: LC allows `Course`/`Lesson`/`Activity → InstructionalRoutine`
   (see [`relationships.md`](relationships.md) and [`node-types.md`](node-types.md)), so
   a genuine pedagogy routine attached to a `Lesson` is canonical.)*
