# LC node types — data model per label

Verbatim from <https://docs.learningcommons.org/knowledge-graph/schema-reference/>
(CC BY 4.0 — see [`README.md`](README.md) for attribution). Cardinality: `1` = required
single, `0..1` = optional single, `1..n` = required multi, `0..n` = optional multi.
"Gated" = a dataset-gated label in LC. **★ = a label this project uses.**

The four families: **Standards** (`StandardsFramework`, `StandardsFrameworkItem`),
**Learning Components** (`LearningComponent`), **Curriculum/content** (`Course`,
`LessonGrouping`, `Lesson`, `Activity`, `Assessment`, `Material`, `ClassroomMaterial`,
`GlossaryTerm`, `InstructionalRoutine`), **Instructional Practices** (`LearnerModel`,
`Factor`, `Strategy`).

---

## Standards

### ★ `StandardsFramework`
The root of a standards tree.

| Property | Type | Card. | Description |
|---|---|---|---|
| academicSubject | AcademicSubjectENUM | 1 | Academic subject |
| adoptionStatus | AdoptionStatusENUM | 1 | Adoption status within jurisdiction |
| attributionStatement | String | 1 | Source credit; includes state for state frameworks |
| author | String | 1 | Content author |
| caseIdentifierURI | String | 1 | URI referencing CASE Network item |
| caseIdentifierUUID | String | 1 | UUID referencing CASE Network item |
| dateCreated | Date | 0..1 | Creation date |
| dateModified | Date | 0..1 | Last modification date |
| description | String | 0..1 | Item description |
| identifier | String | 1 | Unique identifier |
| inLanguage | LanguageENUM | 1 | Content language |
| jurisdiction | JurisdictionENUM | 1 | Geographic/political authority |
| license | String | 1 | License URL |
| name | String | 0..1 | Item name |
| notes | String | 0..1 | Additional context |
| provider | String | 1 | Service provider |
| isCurrent | Boolean | 1 | Whether this is most up-to-date for state-subject pair |

**Relationships:** `hasChild` → `StandardsFrameworkItem`.

### ★ `StandardsFrameworkItem` (SFI)
A node in the standards tree (a standard or a grouping of standards).

| Property | Type | Card. | Description |
|---|---|---|---|
| academicSubject | AcademicSubjectENUM | 1 | Academic subject |
| attributionStatement | String | 1 | Source credit |
| author | String | 1 | Content author |
| caseIdentifierURI | String | 1 | URI referencing CASE Network item |
| caseIdentifierUUID | String | 1 | UUID referencing CASE Network item |
| dateCreated | Date | 0..1 | Creation date |
| dateModified | Date | 0..1 | Last modification date |
| description | String | 0..1 | Item description |
| gradeLevel | Array of GradeLevelENUM | 0..n | Educational grade(s) |
| identifier | String | 1 | Unique identifier |
| inLanguage | LanguageENUM | 1 | Content language |
| jurisdiction | JurisdictionENUM | 1 | Geographic/political authority |
| license | String | 1 | License URL |
| normalizedStatementType | NormalizedStatementTypeENUM | 1 | Functional role within framework (Standard / Standard Grouping / …) |
| notes | String | 0..1 | Additional context |
| provider | String | 1 | Service provider |
| statementCode | String | 0..1 | Short alphanumeric identifier within context |
| alternateStatementCode | String | 0..1 | Alternate code used by publishers/teachers |
| statementType | String | 0..1 | Framework-specific classification label |

**Relationships (as source):** `hasChild` → `SFI`; `buildsTowards` → `SFI`;
`relatesTo` → `SFI`; `hasStandardAlignment` → `SFI` (state→CCSS crosswalk).
**Receives:** `hasChild` from `StandardsFramework`/`SFI`; `supports` from
`LearningComponent`; `hasEducationalAlignment` from content nodes.

---

## Learning Components

### ★ `LearningComponent`
"Single, well-defined skill or concept that students are expected to learn."

| Property | Type | Card. | Description |
|---|---|---|---|
| academicSubject | AcademicSubjectENUM | 1 | Academic subject |
| attributionStatement | String | 1 | Source credit |
| author | String | 1 | Author |
| dateCreated | Date | 0..1 | Creation date |
| dateModified | Date | 0..1 | Last modification date |
| description | String | 1 | Description of the skill/concept |
| examples | Array | 0..n | Illustrative classroom scenarios (present on some, not all) |
| identifier | String | 1 | Identifier (string or URI) |
| inLanguage | LanguageENUM | 1 | Language |
| license | String | 1 | License URL |
| provider | String | 1 | Service provider |

**Relationships:** `supports` → `StandardsFrameworkItem`.

---

## Curriculum / content

Content nests by **`hasPart`**; the legal children per label are fixed (below).
Every content label may align to standards via `hasEducationalAlignment` → `SFI`.

### ★ `Course`
| Property | Type | Card. |
|---|---|---|
| academicSubject | AcademicSubjectENUM | 0..1 |
| attributionStatement | String | 1 |
| audience | EducationalAudienceENUM | 1..n |
| author | String | 1 |
| courseCode | String | 0..1 |
| curriculumLabel | String | 0..1 |
| dateCreated | Datetime | 0..1 |
| description | String | 0..1 |
| educationalUse | EducationalUseENUM | 0..1 |
| gradeLevel | Array of GradeLevelENUM | 0..n |
| identifier | String | 1 |
| inLanguage | LanguageENUM | 0..1 |
| license | String | 1 |
| lmsLoadingGuidance | lmsLoadingGuidanceENUM | 0..1 |
| name | String | 0..1 |
| provider | String | 0..1 |
| providerDateCreated | Datetime | 1 |
| providerDateModified | Datetime | 1 |
| publisherIdentifier | String | 0..1 |
| timeRequired | Duration | 0..1 |

**Relationships:** `hasPart` → **`LessonGrouping`, `Material`**; `hasEducationalAlignment` → `SFI`; `usesRoutine` → `InstructionalRoutine`.

### ★ `LessonGrouping`
A unit/chapter/week — a grouping of lessons.

| Property | Type | Card. |
|---|---|---|
| academicSubject | AcademicSubjectENUM | 0..1 |
| attributionStatement | String | 1 |
| audience | EducationalAudienceENUM | 1..n |
| author | String | 1 |
| courseCode | String | 0..1 |
| curriculumLabel | String | 0..1 |
| dateCreated | Datetime | 0..1 |
| description | String | 0..1 |
| educationalUse | EducationalUseENUM | 0..1 |
| gradeLevel | GradeLevelENUM | 0..n |
| groupLevel | Integer | 1 |
| groupName | String | 1 |
| identifier | String | 1 |
| inLanguage | LanguageENUM | 0..1 |
| isOptional | Boolean | 0..1 |
| license | String | 1 |
| lmsLoadingGuidance | lmsLoadingGuidanceENUM | 0..1 |
| name | String | 0..1 |
| ordinalName | String | 0..1 |
| position | Integer | 0..1 |
| provider | String | 0..1 |
| providerDateCreated | Datetime | 1 |
| providerDateModified | Datetime | 1 |
| publisherIdentifier | String | 0..1 |
| timeRequired | Duration | 0..1 |

**Relationships:** `hasPart` → **`Assessment`, `Lesson`, `LessonGrouping`, `Material`**;
`hasEducationalAlignment` → `SFI`; `hasDependency` → `LessonGrouping`; `hasReference`
→ `Assessment`/`Lesson`. **Receives** `hasPart` from `Course`/`LessonGrouping`.

### ★ `Lesson`
| Property | Type | Card. |
|---|---|---|
| academicSubject | AcademicSubjectENUM | 0..1 |
| attributionStatement | String | 1 |
| audience | EducationalAudienceENUM | 1..n |
| author | String | 1 |
| courseCode | String | 0..1 |
| curriculumLabel | String | 0..1 |
| dateCreated | Datetime | 0..1 |
| description | String | 0..1 |
| educationalUse | EducationalUseENUM | 0..1 |
| gradeLevel | GradeLevelENUM | 0..n |
| identifier | String | 1 |
| inLanguage | LanguageENUM | 0..1 |
| isOptional | Boolean | 0..1 |
| license | String | 1 |
| lmsLoadingGuidance | lmsLoadingGuidanceENUM | 0..1 |
| name | String | 0..1 |
| ordinalName | String | 0..1 |
| position | Integer | 0..1 |
| provider | String | 0..1 |
| providerDateCreated | Datetime | 1 |
| providerDateModified | Datetime | 1 |
| publisherIdentifier | String | 0..1 |
| timeRequired | Duration | 0..1 |

**Relationships:** `hasPart` → **`Activity`, `Assessment`, `Material`**;
`hasEducationalAlignment` → `SFI`; `usesRoutine` → `InstructionalRoutine`; `uses` →
`ClassroomMaterial`; `hasDependency` → `Lesson`; `hasReference`/`references` →
`Lesson`/`Activity`/`Assessment`/`LessonGrouping`/`GlossaryTerm`. **Receives** `hasPart`
from `LessonGrouping`.

### ★ `Activity`
| Property | Type | Card. |
|---|---|---|
| academicSubject | AcademicSubjectENUM | 0..1 |
| attributionStatement | String | 1 |
| audience | EducationalAudienceENUM | 1..n |
| author | String | 1 |
| courseCode | String | 0..1 |
| curriculumLabel | String | 0..1 |
| dateCreated | Datetime | 0..1 |
| educationalUse | EducationalUseENUM | 0..1 |
| gradeLevel | GradeLevelENUM | 0..n |
| gradingRequired | Boolean | 0..1 |
| identifier | String | 1 |
| inLanguage | LanguageENUM | 0..1 |
| isOptional | Boolean | 0..1 |
| license | String | 1 |
| lmsLoadingGuidance | lmsLoadingGuidanceENUM | 0..1 |
| name | String | 0..1 |
| ordinalName | String | 0..1 |
| position | Integer | 0..1 |
| provider | String | 0..1 |
| providerDateCreated | Datetime | 1 |
| providerDateModified | Datetime | 1 |
| publisherIdentifier | String | 0..1 |
| studentGroupingType | StudentGroupingTypeENUM | 0..1 |
| submissionRequired | Boolean | 0..1 |
| timeRequired | Duration | 0..1 |

**Relationships:** `hasPart` → **`Material`**; `hasEducationalAlignment` → `SFI`;
`usesRoutine` → `InstructionalRoutine`; `uses` → `ClassroomMaterial`; `hasDependency`
→ `Activity`; `hasReference` → `Lesson`. **Receives** `hasPart` from `Lesson`.

### `Assessment`
Same shape as `Activity` minus `ordinalName`/`position`, plus `variant` (String, 0..1).
`educationalUse` typically `Assessment`.

**Relationships:** `hasPart` → `Material`; `hasEducationalAlignment` → `SFI`;
`hasReference` → `Lesson`/`LessonGrouping`; `mutuallyExclusiveWith` → `Assessment`.
**Receives** `hasPart` from `Lesson`/`LessonGrouping`.

### ★ `Material` (gated)
The load-bearing content leaf — its `content` is required.

| Property | Type | Card. |
|---|---|---|
| academicSubject | AcademicSubjectENUM | 0..1 |
| attributionStatement | String | 1 |
| audience | EducationalAudienceENUM | 1..n |
| author | String | 1 |
| content | String | 1 |
| educationalUse | EducationalUseENUM | 0..1 |
| identifier | String | 1 |
| inLanguage | LanguageENUM | 0..1 |
| license | String | 1 |
| materialType | MaterialTypeENUM | 1 |
| name | String | 0..1 |
| ordinalName | String | 0..1 |
| provider | String | 0..1 |
| providerDateCreated | Datetime | 1 |
| providerDateModified | Datetime | 1 |
| publisherIdentifier | String | 0..1 |

**Relationships:** `hasEducationalAlignment` → `SFI`. **Receives** `hasPart` from
`Course`/`LessonGrouping`/`Activity`/`Assessment`/`Lesson`/`InstructionalRoutine`.

### `ClassroomMaterial` (gated)
Teacher-facing resource. Receives `uses` from `Lesson`/`Activity`.

### `GlossaryTerm` (gated)
Receives `references` from `Lesson`.

### `InstructionalRoutine` (gated)
`hasPart` → `InstructionalRoutine`/`Material`; `hasReference` → `Activity`/`Lesson`.
Receives `usesRoutine` from `Course`/`Lesson`/`Activity`.

---

## Instructional Practices

`LearnerModel`, `Factor`, `Strategy` — used with `hasFactor`, `hasStrategy`,
`interactsWithFactor`, `targetsFactor`, `relevantToStandard`. Not used by this project;
see the LC docs for full schemas.
