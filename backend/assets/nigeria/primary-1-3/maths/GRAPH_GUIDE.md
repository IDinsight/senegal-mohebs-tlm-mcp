# Nigeria Maths (Primary 1–3) — graph guide

How the Nigeria maths knowledge graph is shaped. This is a **standards-only
reference framework** — the NERDC 9-Year Basic Education Mathematics Curriculum
(an EIDU export). There is no teaching content to author or generate: no `Lesson`,
`Activity`, or `Material`, and no deliverables. You browse and align against it;
you do not author lessons into it.

## The hierarchy

A single `StandardsFramework` root, then a pure `hasChild` tree of
`StandardsFrameworkItem`s whose **kind is their level** (their `statementType`):

```
Grade (PRIMARY ONE / TWO / THREE)
  └─ Theme            ("EVERY DAY STATISTICS", "ALGEBRAIC PROCESSES", …)
       └─ Sub-Theme   ("Data Collection and Presentation", …)
            └─ Topic   ("Data Collection", "Open Sentences", …)
                 ├─ Content               (the curriculum content statement)
                 └─ Performance Objective (what a pupil should be able to do)
```

`Content` and `Performance Objective` are the leaves. A `LearningComponent`
`supports` a `Performance Objective` or a `Content` — the fine-grained skills EIDU
attaches beneath the objectives.

## Only two edge types

- `hasChild` — the containment tree above (Grade → … → Content / Performance Objective).
- `supports` — a `LearningComponent` to the SFI it elaborates.

There is **no** `hasPart`, no `hasEducationalAlignment`, and no ordinal field —
sequence is traversal order, not a `position`.

## Conventions

- **Kinds are the graph's own words** — an SFI's level is its `statementType`
  (`Grade`/`Theme`/`Sub-Theme`/`Topic`/`Content`/`Performance Objective`); the
  fine-grained skills are `LearningComponent`s by label.
- **No content authoring, no coverage.** This framework exists to be browsed and
  aligned against, not to hold generated materials — a reference framework has
  nothing to "complete", so there are no coverage expectations.
- **Deleting is bulk and cascades.** `delete_nodes` / `delete_edges` each take an
  ARRAY (one or many, one atomic draft edit, all-or-nothing). `delete_nodes` cascades
  along `hasChild`: removing an SFI takes its descendants and their incident
  `supports`/`hasChild` edges. The dry-run WARNS with the full set before you confirm
  (no force flag). Rare here — this is a reference framework — but that is how
  framework maintenance works.
