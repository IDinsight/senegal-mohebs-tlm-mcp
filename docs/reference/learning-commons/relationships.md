# LC relationships — all possibilities

Every relationship (edge) type, its **legal source → target** node types, and its
meaning. Verbatim from <https://docs.learningcommons.org/knowledge-graph/schema-reference/>
(CC BY 4.0 — see [`README.md`](README.md)). **★ = used by this project.**

An edge is only canonical if its **type AND its (source label → target label) pair**
both appear below. The `node-types.md` per-label "Relationships" lists are the same
facts viewed from the node side — cross-check both.

## Edge catalogue

| Edge | Legal source → target | Family | Meaning | Used |
|---|---|---|---|---|
| `hasChild` | `StandardsFramework` → `SFI`; `SFI` → `SFI` | Standards | Parent→child in the **standards** tree. **Standards-only** — never targets content. | ★ |
| `supports` | `LearningComponent` → `SFI` | Standards / LC | The component contributes to mastery of the standard. | ★ |
| `hasEducationalAlignment` | `Course`/`LessonGrouping`/`Lesson`/`Activity`/`Assessment`/`Material` → `SFI` | Curriculum→Standards | The **only** bridge from content to the standard it teaches/assesses. Carries `alignmentType` (e.g. `teaches`, `assesses`) + `curriculumAlignmentType` (e.g. `addressing`, `building_on`). | ★ |
| `hasStandardAlignment` | `SFI` (state) → `SFI` (CCSS) | Standards | State↔CCSS crosswalk when they share Learning Components (carries `jaccard`, `*LCCount`). | |
| `buildsTowards` | `SFI` → `SFI` | Learning Progressions | Directional progression (proficiency in one supports success in the next). **SFI↔SFI only.** | ★ |
| `relatesTo` | `SFI` ↔ `SFI` | Learning Progressions | Non-directional conceptual/skill link. **SFI↔SFI only.** | ★ |
| `hasPart` | `Course`→`LessonGrouping`/`Material`; `LessonGrouping`→`Lesson`/`LessonGrouping`/`Assessment`/`Material`; `Lesson`→`Activity`/`Assessment`/`Material`; `Activity`→`Material`; `Assessment`→`Material`; `InstructionalRoutine`→`InstructionalRoutine`/`Material` | Curriculum | Compositional nesting of the **content** tree. Legal children are fixed per label. | ★ |
| `hasDependency` | `LessonGrouping`→`LessonGrouping`; `Lesson`→`Lesson`; `Activity`→`Activity` | Curriculum | Prerequisite/sequential requirement **between content** (the content-tree analogue of `buildsTowards`). | |
| `hasReference` | content → content (see per-label lists) | Curriculum | Content citation/cross-link. | |
| `references` | `Lesson` → `Lesson`/`GlossaryTerm` | Curriculum | Content citation. | |
| `usesRoutine` | `Course`/`Lesson`/`Activity` → `InstructionalRoutine` | Curriculum | Applies an instructional routine. | |
| `uses` | `Lesson`/`Activity` → `ClassroomMaterial` | Curriculum | Uses a classroom resource. | |
| `mutuallyExclusiveWith` | `Assessment` ↔ `Assessment` | Curriculum | Pick-one-of exclusivity. | |
| `hasFactor` / `hasStrategy` / `interactsWithFactor` / `targetsFactor` / `relevantToStandard` | Instructional-Practices labels | Instructional Practices | Learner-model composition & targeting. | |

### The rules that catch most mistakes

- **`hasChild` is standards-only.** `SFI → Lesson`, `SFI → LessonGrouping`, `SFI →
  Activity` are all **off-canon**. Content nests by `hasPart`.
- **Content → standards is `hasEducationalAlignment`, one direction only.** There is
  **no** standards → content edge.
- **`buildsTowards`/`relatesTo` are `SFI↔SFI`.** Progressions between chapters/lessons
  are off-canon — use `hasDependency` for content prerequisites.
- **`hasPart` children are typed.** A `Course` cannot `hasPart` a `Lesson` (only
  `LessonGrouping`/`Material`); an `Activity` cannot `hasPart` anything but `Material`.

## Common relationship properties

LC represents every edge with a shared property bag (24 properties). The identity
ones we rely on:

| Property | Type | Description |
|---|---|---|
| `relationshipType` | String | Normalized edge type (`hasChild`, `hasPart`, `supports`, `hasEducationalAlignment`, …) — mirrors the edge's type. |
| `sourceEntity` | String | Source node's entity type (label). |
| `targetEntity` | String | Target node's entity type (label). |
| `sourceEntityKey` | String | Property name holding the source's id (we use `identifier`). |
| `targetEntityKey` | String | Property name holding the target's id (we use `identifier`). |
| `sourceEntityValue` / `targetEntityValue` | String | The source/target id values. |
| `identifier` | String | The edge's own id. |
| `license` / `attributionStatement` / `author` / `provider` | String | Provenance, per the content license. |
| `dateCreated` / `dateModified` | Date | Timestamps. |
| `description` | String | Free text. |

Alignment-specific: `alignmentType`, `curriculumAlignmentType`. Crosswalk-specific
(Standards / Learner Variability only): `jaccard`, `ccssLCCount`, `sharedLCCount`,
`stateLCCount`. Instructional-Practices-specific: `connectionType`, `factorCategory`.
