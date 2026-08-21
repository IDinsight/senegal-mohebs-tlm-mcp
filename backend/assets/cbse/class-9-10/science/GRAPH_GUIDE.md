# CBSE Science (Class 9–10) — graph guide

How the CBSE science knowledge graph is shaped. This is a **standards-only
reference framework** — the "Learning Framework — Science" from the Central Board
of Secondary Education (CBSE), developed with Azim Premji University (an EIDU
export). There is no teaching content to author or generate: no `Lesson`,
`Activity`, or `Material`, and no deliverables. You browse and align against it;
you do not author lessons into it.

## The hierarchy

A single `StandardsFramework` root, then a pure `hasChild` tree of
`StandardsFrameworkItem`s whose **kind is their level** (their `statementType`):

```
Class (Class IX / Class X)
  └─ Content Domain        (a broad science domain)
       └─ Chapter          (a chapter within the domain)
            ├─ NCERT Learning Outcome                    (an official NCERT outcome)
            └─ Content Domain Specific Learning Outcome  (a CLO for the chapter)
                 └─ Indicator   (an observable pupil-level indicator)
```

`Indicator` is the finest standards leaf. A `LearningComponent` `supports` a
`Content Domain Specific Learning Outcome` or an `Indicator` — the fine-grained
skills EIDU attaches beneath the outcomes.

## Only two edge types

- `hasChild` — the containment tree above (Class → … → Indicator).
- `supports` — a `LearningComponent` to the SFI it elaborates.

There is **no** `hasPart`, no `hasEducationalAlignment`, and no ordinal field —
sequence is traversal order, not a `position`.

## Conventions

- **Kinds are the graph's own words** — an SFI's level is its `statementType`
  (`Class`/`Content Domain`/`Chapter`/`NCERT Learning Outcome`/`Content Domain
  Specific Learning Outcome`/`Indicator`); the fine-grained skills are
  `LearningComponent`s by label.
- **No content authoring, no coverage.** This framework exists to be browsed and
  aligned against, not to hold generated materials — a reference framework has
  nothing to "complete", so there are no coverage expectations.
- **Deleting is bulk and cascades.** `delete_nodes` / `delete_edges` each take an
  ARRAY (one or many, one atomic draft edit, all-or-nothing). `delete_nodes` cascades
  along `hasChild`: removing an SFI takes its descendants and their incident
  `supports`/`hasChild` edges. The dry-run WARNS with the full set before you confirm
  (no force flag). Rare here — this is a reference framework — but that is how
  framework maintenance works.
