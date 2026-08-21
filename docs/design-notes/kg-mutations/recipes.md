## Step 0 findings for #14 — curriculum recipes (composite mutations)

### Restated reference regime (REUSED from #13, not re-derived)

Predominantly **Regime A** (id-based edges), with **exactly one denormalized
Regime-B field: CI maths `raw.chapitreNum`.**

- **Referential backbone = 100% id-based `hasChild` / `buildsTowards` edges.**
  Rule 2 blocks any dangling edge. Every recipe's rewire runs on this spine, and
  the note about "hasLesson" in the task is nominal only — the store's
  chapter→lesson relation is a `hasChild` **edge**, not an edge type named
  "hasLesson".
- **`raw.chapitreNum` is a number-based reference the CI maths PRESENTER joins on.**
  `lessonsOf` filters `lesson.raw.chapitreNum === chapNum`, NOT the hasChild
  edge. That edge also exists (denormalized copy), so the number is a copy of an
  already-Rule-2-guarded edge. #13 resolved its drift as a **WARNING, not a
  block** (decision (c)): the backbone stays intact, so drift is a presentation
  inconsistency, not corruption.

**Enumerated referrers a recipe must keep consistent:** `edge.from`/`edge.to`
(id — Rule 2, blocks); `raw.chapitreNum` (number — CI maths chapter↔lesson join;
drift WARNED); `order` / `raw.leconNum` (within-chapter ordering only); `code` /
`raw.statementCode` (display only, NOT a reference).

**The load-bearing consequence, honestly stated:** because #13 chose WARN not
BLOCK for `chapitreNum` drift, a recipe's safety comes from **the recipe itself
cascade-rewriting** the affected `chapitreNum` family atomically (so no drift
warning fires), **not** from Rule 2 hard-blocking. Rule 2 only blocks genuine
EDGE dangling, and a structural-property edit never dangles an edge, so Rule 2
never fires for renumber. This means **move_lesson and split_chapter are
Regime-B-affected too**, not just renumber: rewiring the hasChild edge without
rewriting the moved lesson's `chapitreNum` would leave it rendering under its
OLD chapter. All three rewrite `chapitreNum` as part of the same composite —
which is why they share one structural-property edit path. The renumber cascade
is **bounded** (one chapter + its direct hasChild lessons, ~5–20 nodes) — not a
large cascade, so no stop-and-report was needed.

### The recipe model (as built)

A recipe is a SINGLE #5 `GraphMutation` whose `apply(base,args)` composes several
#12 primitive `apply` functions (`createNode` / `linkNodes` / `unlinkNodes`) +
structural-property edits, all pure and atomic. The framework gives it, for
free: one whole-composite diff + one token on dry-run (no state change); #13's
`validateStructural` (Rule 1 + Rule 2) over the WHOLE resulting draft; coverage
warnings; one #7 audit `apply` event tagged with the recipe name; #8's role
gate. An invalid composite is rejected as a WHOLE (validate blocks the token) —
nothing partial lands. Recipes are NOT Claude orchestrating separate primitive
calls. The recipe logic now lives in the [`src/kg-recipes/`](../../../backend/src/kg-recipes/registry.ts)
module (it moved out of `kg-store/` in the generic-verb refactor — see this folder's
[README status](README.md)); tools in [`src/server/recipes.ts`](../../../backend/src/server/recipes.ts).

Subject-agnosticism is preserved exactly as #10/#12 did it: kg-store never names
"chapter"/"lesson"/"hasChild". Each recipe reads that vocabulary from a
`RecipeProfile` + `structuralAliases` + `wordingAliases` threaded through its
args; the server tool layer reads them off the active adapter. A subject with no
`recipeProfile` (CE1 reading, today) simply has no recipes — the tool returns a
clear "not available" message.

### Decisions (a)–(f) — as implemented (all recommended options, user-confirmed)

**(a) Editable structural keys — minimal set.** `order`, `raw.chapitreNum`,
`raw.leconNum`, gated by a central `STRUCTURAL_EDIT_SAFE_PATHS` allowlist in
kg-store (the exact analogue of `UPSERT_PROPERTY_SAFE_PATHS`, kept separate so
wording and structure never blur). Exposed via a `structuralAliases` map on the
adapter (same shape as `wordingAliases`): `chapter.number → [order,
raw.chapitreNum]`; `lesson.chapterNumber → [raw.chapitreNum]`; `lesson.position
→ [order, raw.leconNum]`. Values are numeric; the "existing key must hold a
number" discipline mirrors #10. `code`/`statementCode` are display-only and stay
out.

**(b) Preserve numbers; renumber only when explicit.** move/split set only the
MOVED lessons' `chapterNumber` to their new home's number (mandatory for
correctness); they never touch other chapters' numbers, and they preserve each
moved lesson's within-chapter position.

**(c) add_chapter = append / gap-fill only.** The number must be FREE; a
colliding number is rejected in the additive path. Inserting BETWEEN chapters
(shifting the rest) is out of the additive path.

**(d) Edge rewiring.** move/split unlink the old `hasChild(oldChapter→lesson)`
and link `hasChild(newChapter→lesson)` + rewrite `chapitreNum`; Rule 2 validates
the whole result; coverage warns (e.g. a chapter left without a bilan) but never
blocks. Verified in tests.

**(e) Recipes-only (user-confirmed).** The structural-property edit path is an
internal mutation used by the recipes; there is NO raw `set_structural_property`
tool. A raw `chapitreNum` edit is exactly the drift the recipes exist to prevent.

**(f) Capabilities = a MIRROR of the registry.** `get_capabilities` renders the
`RECIPES` array straight from `recipes.ts` (never a hand-authored list), marking
each recipe `renumberBearing` (renumber) and `regimeGated` (move/split/renumber
— the ones that rewrite the `chapitreNum` join key). It also mirrors the
editable structural keys (adapter `structuralAliases` + the safe-path allowlist).

### Renumber under this regime — the one recipe whose risk is regime-dependent

`renumber(chapterId, newNumber)` (user-confirmed **free-number only**): it
rewrites the chapter's number (`order` + `raw.chapitreNum`) AND cascade-rewrites
every child lesson's `raw.chapitreNum` in the same atomic composite, so the
family stays consistent and no drift warning fires. The target number must be
FREE — renumber MOVES a chapter to an unoccupied number; insert-with-shift and
swap are explicitly rejected (a separate, larger operation not built here).

### Recipe signatures

- `add_lesson(chapterId, text, [text_en, order, isBilan])` — create lesson +
  `hasChild` link; sets the lesson's `chapterNumber` from the chapter. Additive.
- `add_chapter(number, title, [title_en, lessons[]])` — create chapter (+ seed
  lessons) as one composite; `number` must be free.
- `move_lesson(lessonId, toChapterId, [position])` — unlink + relink + rewrite
  `chapterNumber`; append by default.
- `split_chapter(chapterId, atLessonId, [newTitle, newTitle_en, newNumber])` —
  new chapter (appended at max+1 by default) + move tail lessons + rewrite their
  `chapterNumber`.
- `renumber(chapterId, newNumber)` — chapter number + child lessons' cascade;
  free number only.

Recipes that create nodes mint the id(s) server-side and surface them on the
dry-run (`mintedLessonId` / `mintedChapterId` / `mintedLessonIds`), exactly as
`create_node` surfaces `mintedNodeId`; the caller passes them back on confirm.

### Non-goals (unchanged)

Recipes are the only composites; #12 primitives stay atomic single ops.
Structural editing is limited to the curated key set (wording stays #10). No
cascade beyond #13's explicit force; no silent renumber. Coverage is WARNED,
never BLOCKED by recipes. No new schema/profile/template layer.
