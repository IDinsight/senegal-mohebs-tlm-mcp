# LC enums & formats

Verbatim from
<https://docs.learningcommons.org/knowledge-graph/schema-reference/enums-and-formats>
(CC BY 4.0 — see [`README.md`](README.md)). These are the allowed values for the
enum-typed properties in [`node-types.md`](node-types.md).

| Enum | Allowed values |
|---|---|
| `AcademicSubjectENUM` | English Language Arts · Mathematics · Social Studies · Science · Other · Durable Skills |
| `AdoptionStatusENUM` | Draft · Proposed · Adopted · Implemented · Retired |
| `EducationalAudienceENUM` | Teacher · Student · Family |
| `EducationalUseENUM` | **Instruction · Assessment** |
| `GradeLevelENUM` | PK · K · 1 · 2 · 3 · 4 · 5 · 6 · 7 · 8 · 9 · 10 · 11 · 12 · null |
| `JurisdictionENUM` | All 50 U.S. states (Alabama–Wyoming) · Washington, D.C. · Multi-State |
| `LanguageENUM` | en-US · es-US |
| `lmsLoadingGuidanceENUM` | Required · Recommended · Optional · Not Recommended · Unspecified |
| `MaterialTypeENUM` | Core · Supporting · Reference |
| `NormalizedStatementTypeENUM` | **Standard · Standard Grouping · Other · null** |
| `StudentGroupingTypeENUM` | Individual · Pair · Small Group · Whole Class |

## Formats

- **`Duration`** — ISO 8601: `PnY` (years), `PnM` (months), `PnW` (weeks), `PnD`
  (days), `PTnH` (hours), `PTnM` (minutes), `PTnS` (seconds); combined
  `PnYnMnDTnHnMnS` (e.g. `PT45M` = 45 minutes).
- **`Datetime` / `Date`** — ISO 8601.
- **`identifier`** — string or URI.

## Notes for this project

- `LanguageENUM`/`JurisdictionENUM` are US-centric. Our Senegal FR content uses
  `inLanguage: "fr-FR"` and `jurisdiction: "Senegal"` — **outside the LC enums by
  necessity**. Treat these as intentional, project-specific extensions.
- We drive grouping-vs-leaf off `normalizedStatementType === "Standard Grouping"`.
  That value is canonical for **`StandardsFrameworkItem`**; on our content
  `LessonGrouping`s it is a non-canonical carry-over (see `README.md` deviation #3).
- Our bilan flag uses `educationalUse: "Assessment"` — a valid `EducationalUseENUM`
  value — on a `Lesson`, rather than a dedicated `Assessment` node.
