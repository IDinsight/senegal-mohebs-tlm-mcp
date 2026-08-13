## Step 0 findings for #13 — full referential integrity (cascade + coverage)

### The reference regime — resolved: predominantly A, one denormalized B field

The number-vs-id question, traced through both the store and every adapter's
read path:

- **Store referential backbone = 100% id-based edges (Regime A).** Every
  genuine cross-entity link is a `hasChild` or `buildsTowards` edge keyed by
  `from`/`to` node id. Rule 2 already guards all of them. Covers
  lesson→component, component→task, week→standard, standard→component, and
  chapter→chapter progression.
- **Exactly one number-based reference (Regime B), CI maths only: `raw.chapitreNum`.**
  The CI maths *presenter* joins a chapter to its lessons by matching
  `raw.chapitreNum` (`lessonsOf` filters `lesson.raw.chapitreNum === chapNum`),
  NOT by the `hasChild` edge. But that chapter→lesson `hasChild` edge ALSO
  exists in the store (serialize emits it from the number-derived `childIds`),
  so `chapitreNum` is a **denormalized copy** of an edge that's already
  Rule-2-protected — not an independent reference.

Enumerated reference sites: `edge.from`/`edge.to` (id, all subjects, Rule 2);
`raw.chapitreNum` (number, CI maths chapter↔lesson, denormalized); `order` /
`raw.leconNum` (ordering only, not a cross-ref); `code` / `raw.statementCode`
(display only); CE1 reading's `raw.case_identifier_uuid` (parse-time join for raw
`supports`, resolved to an id-edge at serialize — not a store-level ref).

**Verified on seed data** (via a serialize + count check): 25 chapters, all
non-empty, each with exactly one bilan, zero `chapitreNum` drift. So none of
the coverage warnings fire on untouched seed data — they only appear once a
curator introduces incompleteness, and parity is unaffected.

### Decision (a) — cascade scope on force-delete

`delete_node(force:true)` removes the target + its **hasChild dependent
subtree** + every incident edge, atomically. "Dependent" = a hasChild
descendant *all* of whose hasChild parents are in the removed set (computed to
a fixpoint in `cascadeRemovedNodeIds`), so a child shared with a surviving
parent stays put (only its edge to the removed parent drops). Progression
neighbours (`buildsTowards`) are NOT dependents — their connecting edge is
removed, they survive. The dry-run diff shows the full removed set; Rule 1/2
re-run on the result. Cascade follows the id-edge backbone; a child attached by
`chapitreNum` number-only (a drift state) is not in the subtree — an accepted
edge case the coverage warnings already flag.

### Decision (b) — the coverage rules (all WARNINGS, never blocks)

Grounded in real curriculum expectations, not invented:
- **Empty container** (generic) — a chapter/week with zero hasChild children.
- **Missing / duplicate bilan** (CI maths) — a chapter with lessons but no
  `isAssessment` lesson, or more than one.
- **Lesson with >1 parent** (generic) — a hasChild child with two parents.
- **`chapitreNum` drift** (CI maths, Regime-B consistency) — a lesson whose
  `chapitreNum` disagrees with its hasChild-parent chapter's, or matches no
  chapter at all. This is exactly the check that the denormalized copy still
  agrees with the edge backbone.

### Decision (c) — Regime-B field handling

`raw.chapitreNum` drift is a **WARNING, not a block**: the referential backbone
(the hasChild edge) stays Rule-2-guarded, so drift is presentation
inconsistency (valid-but-suspect), not corruption. Blocking it would force
`create_node`/`link_nodes` to enforce number-matching — a new constraint out of
scope here. **Implication for the future renumber action:** renumbering a
chapter is only reference-safe if it cascade-rewrites every lesson's
`chapitreNum`; the drift warning is precisely the signal that fires if it
doesn't.

### Decision (d) — where warnings surface

BOTH the per-mutation dry-run (`runGraphMutation`, computed on the post-apply
graph) AND the whole-draft `diff_draft` (the approver's pre-publish view). The
`publish_draft` dry-run shows them too, and the publish audit records
`warningsAtPublish` for traceability. Publish is NEVER blocked by warnings.

### Interface / seam

- `validateStructural(publishedReference, after)` unchanged — still the
  universal, id-based BLOCK layer (Rules 1 + 2), no subject vocabulary.
- New optional `SubjectAdapter.coverageWarnings(graph): string[]` — the
  unit-shaped WARN layer. Subject-neutral shapes (empty container, multi-parent)
  are reusable helpers in `curriculum/coverage.ts`; subject-specific rules
  (bilan, `chapitreNum` drift) live in the CI maths adapter. CE1 reading uses the
  generic helpers only.
- `runGraphMutation` and `diffDraft` gain an optional injected `coverage`
  callback (wired by the server layer from the active adapter) and merge its
  output into `warnings`. `publishDraft` gains an optional `warningsAtPublish`
  recorded on the publish audit. kg-store stays subject-agnostic throughout —
  it only ever calls the injected function, never names a unit kind.
- `deleteNode` gains `force?: boolean`; `apply` branches (isolated-only vs
  subtree cascade), `validate` refuses a connected node only when `!force`.

### Non-goals (unchanged from the task)

No curriculum recipes/composites (that's the next step, which builds on this
layer). No renumber ACTION (this step only ensures integrity knows the number
is denormalized and warns on drift). Warnings never block publish; cascade
never happens without explicit force. No new schema/profile/template layer.

---
