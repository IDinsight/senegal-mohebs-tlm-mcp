# A reading `Course` + scope-from-Course

> **Status: Phase 1 (the parser) shipped; Phase 2 (the live data) pending.** This
> note gives CE1 reading a content-layer `Course` root — like maths — so it can
> carry routines and a formatter, which unblocks the reading routine catalog and
> retiring the reading generation prompt. Getting there needs the parse-time prune
> generalised (scope-from-Course), which is Phase 1. Extends
> [`authorable-catalog.md`](authorable-catalog.md) and
> [`graph-native-authoring.md`](graph-native-authoring.md).

## Why

Reading has weeks → days → sessions + a standards spine, but **no `Course` root**.
Without one it can't carry a `usesRoutine` routine/formatter (those attach to a
Course or Lesson), so reading's structure + look stay trapped in
`PROMPT_generate_lessons.md` — the last subject that can't be retired to authored
data. Maths already has two Courses; reading should have one.

## The entanglement (why it's one change, not two)

Adding a `Course` atop the weeks isn't parity-neutral, and it breaks the prune:

- Each week's `parentId` changes from *null* (a root) to the Course — a read-model
  change.
- The reading prune (`content-reachable-from-roots`, `rootKinds: ["Semaine"]`) was
  **hardcoded two-level** (root → `Jour`/`Lesson`). Pointing it at `["Course"]`
  alone would drop the weeks (a Course's children are `Semaine`, which the old
  descent didn't keep). So the Course level forces the prune to become a real
  reachability closure — which **is** scope-from-Course.

## Phase 1 — generalise the prune (shipped)

`contentReachableFromRoots` now walks the **containment tree (`childIds`) from each
root to any depth** — Course → week → day → session → Activity/Material — keeping
every node reached, then folds in the standards a kept session teaches (via
`hasEducationalAlignment`) and those standards' components (`supports`). One walk
subsumes the old fixed 2-level descent **and** the separate Activity/Material
closure. It deliberately does **not** descend *into* a standard: a leaf standard's
`childIds` are reversed alignment/supports folds (its sessions + components), not
containment, so following them would drag in the whole spine.

Reading's profile moves to a **transitional** `rootKinds: ["Course", "Semaine"]`:
it prunes correctly whether or not a Course exists yet (weeks still match as
`Semaine` roots), so deploying the parser **before** the Course data exists causes
no empty-parse and no dangling week `parentId`.

**Equivalence + safety.** With no Course in the graph, `["Course","Semaine"]`
prunes to exactly what `["Semaine"]` did (a test asserts the reading kept-set is
identical). A synthetic Course-rooted test proves the closure keeps the
Course→week→day→session tree + aligned standard + component and drops orphans. The
retired parity/faithful-re-export suites are gone, so the guards are: the general
suite (every reading-via-adapter test re-parses the fixture through this prune), a
synthetic prune test, and — at rollout — an `export-kg` round-trip + live
`walk_graph`.

## Phase 2 — the live data (pending)

After Phase 1 deploys:

1. Add one `Course` node named **"Guide de l'enseignant"** and `hasPart` it to the
   ~22 `Semaine` weeks (live curator loop: `add_nodes` + `create_edges` → publish).
   Mirror it into the fixture for durability.
2. Update the reading **guide** ("no chapter and no `Course` node — the `Semaine`
   is the unit" → the new Course).
3. Later: tighten `rootKinds` to `["Course"]`; then author the reading routine
   catalog; then retire `PROMPT_generate_lessons.md`.

## Out of scope

**Maths.** Maths already parses fine (its Courses are in the read model via the
widened parse); applying scope-from-Course to maths — to retire that widening — is
a separate, parity-guarded change with no reading benefit, so it is not folded in
here. The generalised prune is available to it whenever that's taken up.
