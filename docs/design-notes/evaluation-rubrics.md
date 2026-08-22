# Evaluation rubrics — grading grids as catalog data

> **Status: Built, not yet live.** The `rubric` catalog kind, `use_rubric`, and
> `evaluate_document` are implemented and tested; the two authored grids (Annexe 7
> sections A–F in `_shared`, Annexe 8's judgement criteria in `senegal`) exist as
> literals in `scripts/seed-catalog.mjs`. **Not yet seeded, deployed, or attached to
> any document.** The Annexe 8 grid must reach the live `senegal` library through
> `add_to_catalog`, never through `seed:catalog` — see the rollout note at the end.
> Extends [`authorable-catalog.md`](authorable-catalog.md) (the catalog) and
> [`teaching-learning-materials.md`](teaching-learning-materials.md) (the document layer).

## The problem

Senegal's MoE ships two French evaluation grids for teaching materials:

- **Annexe 7** — a *scored* grid. Twelve weighted sections (A–L), each criterion
  scored 0–4, producing a weighted global score.
- **Annexe 8** — a *binary approval gate*. Around sixty Oui/Non questions across
  pedagogical, sociocultural, linguistic and physical criteria. It is the checklist
  someone signs before printing is approved.

They look alike and do opposite jobs, so they are two instruments, not one feature.

## The split that makes this tractable

Every criterion in either grid falls into one of two buckets, and the two buckets
belong in completely different places:

**Steerable before generation.** Annexe 8's physical criteria — margin width,
character size, font, word and line spacing, text–paper contrast, consistent
pagination, uniform pictograms — and its illustration criteria (diversified,
attractive, playful, matching the text, respecting Senegalese realities,
non-stereotyped). These are *specifications*, not judgements. They belong in
**formatters**, so the generator satisfies them by construction. You do not want to
generate a manual with 9pt text and then tick "Non" in a box.

**Genuinely post-hoc.** "Les contenus sont-ils exacts ?", "Les personnages des deux
sexes sont-ils représentés de façon équitable ?", "% de tâches de réflexion vs
répétition". Someone — or a model — has to read the produced document and decide.
These belong in a **rubric**.

That split is why the first phase of this work shipped no rubric code at all: it moved
Annexe 8's steerable half into formatters, which shrank the checklist the machinery
below has to carry. This note covers what was left.

One criterion was already solved before any of this: Annexe 8's opening question —
*contribuent-ils à la couverture de la totalité des objets d'apprentissage
programmés ?* — is what **`review_draft`** answers today, against the guide's coverage
prose. `evaluate_document` points at it rather than duplicating it.

## A rubric is the catalog's third kind

`CatalogKind` becomes `routine | formatter | rubric`, tagged the same way the others
are (`metadata.catalogKind: "rubric"` on the entry). This is additive: `kindOf`
defaults an untagged entry to `routine`, so nothing already seeded shifts meaning.

Structurally a rubric needs no new catalog shape — it is exactly the **nested routine**
shape the catalog already stores, read with different words:

```
InstructionalRoutine (entry)      = the grid        metadata.scale = "0-4" | "oui-non"
  ─hasPart→ InstructionalRoutine  = a section       metadata.weight = "20%"
              ─hasPart→ Material  = a criterion     description = its name
                                                    content     = its measurable indicator
```

`list_catalog` reports a rubric's sections in `steps` (with `weight` where a routine
step has `timeRequired`) and its criteria in each section's `materials`;
`get_catalog_entry` renders the scale, then each weighted section, then each criterion
under its own heading with the node id that holds it.

**Why a criterion gets a heading and a routine step's body does not:** a criterion has
*both* a name ("Alignement aux objectifs") and an indicator ("% des contenus alignés
aux objectifs définis"). Rendering only the body would turn the grid into a list of
loose questions with no scoring labels.

## Where a rubric attaches: the document

`use_rubric` mirrors `use_formatter` exactly — clone the entry's subtree with fresh
ids into the active subject, relabel it to the document layer, and hang it under the
document's `TeachingLearningMaterial` via `hasPart`:

```
TeachingLearningMaterial ─hasPart→ Rubric ─hasPart→ RubricSection ─hasPart→ RubricCriterion
```

A grid judges the **document**, not the curriculum, so it attaches where a formatter
does and never rides a Course's `usesRoutine` edge. `use_rubric` accepts a TLM id or a
Course id (whose covering TLM is resolved for you), the same as `use_formatter`.

Attaching is the point: it makes "which grid governs this document" graph data instead
of convention, and it is what `evaluate_document` reads. A document may carry several
grids — a general quality rubric plus an approval checklist — and all of them are
reported.

Copy-on-use applies here too: the copy is independent, so correcting a master with
`edit_node(..., catalog)` does **not** reach copies already made.

Three labels are added to the non-canonical document layer (`Rubric`,
`RubricSection`, `RubricCriterion`). Canonical LC has no rubric concept, so this
follows the precedent already set by `TeachingLearningMaterial` / `Formatter`.

## `evaluate_document` — the server assembles, the model judges

`evaluate_document` is the document-side counterpart of `review_draft`, and keeps its
defining invariant: **the server assembles the criteria and the facts; the calling
model does the judging.** Nothing here runs an LLM, and nothing here writes.

Given a TLM id (or the Course it covers) it returns:

- every attached rubric — scale, weighted sections, named criteria with their
  indicators and node ids;
- the document — its bucket `relPath`, when it was last updated, and whatever a past
  generation recorded about it (characters, example domains, concepts covered);
- an `instruction` telling the caller to page `get_document_text` to the end and score
  every criterion with evidence.

**The document text is deliberately not inlined.** A chapter manual runs to tens of KB
and would blow the response cap; the caller pages it, exactly as `list_documents`
splits reading from listing.

Two things the instruction is emphatic about, because both are real failure modes:
score from the **whole** document (gender balance is not answerable from the opening
page), and **say so** when a criterion cannot be judged from text at all (Annexe 7's
"taux de compréhension par élèves" needs a field test) rather than inventing a score.

## The two authored grids

**Annexe 7 → `_shared`, sections A–F only.** Pertinence didactique, exactitude
disciplinaire, adaptation au niveau, gestion du langage, qualité des tâches,
explication & feedback. Its content criteria are universal pedagogy, so the shared
library is the honest home.

Sections **G–L are deliberately excluded**: contrôlabilité, cohérence du dispositif,
adaptation contextuelle, efficience, fiabilité, éthique. Read them and it is clear they
judge *the authoring tool and the process*, not the material — "nombre de paramètres
ajustables", "variabilité entre générations", "temps de prise en main". Stamping them
into a document-scoped rubric would imply this server can answer them.

The kept weights are the source document's own and total **80%, not 100%** — the
rubric's summary says so and tells the scorer to renormalise.

**Annexe 8 → `senegal`, judgement criteria only.** Contenus, stratégie pédagogique,
évaluation, réalités socio-culturelles, genre et inclusion, compétences de vie,
critères linguistiques. Annexe 8 is a Senegalese MoE document naming Senegalese
realities throughout, so it belongs to that workspace.

Its **section C (physical) and its illustration block are omitted**, because the
formatters shipped in the first phase enforce them at generation time. The rubric's
summary states this explicitly, so a reader is never misled into thinking the stored
grid is the complete signed Annexe 8.

Its socio-cultural section **is** kept even though the representation formatter steers
the same ground — gender balance across a whole support cannot be verified at
generation time, only read off the finished document.

The grid also carries a scope note: Annexe 8 targets the Cahiers de récits and Livrets
gradués, but **no pupil book is being authored**, so it is applied to the Guide de
l'enseignant.

## Rolling this out

1. `seed:catalog` for `_shared` — this is how Annexe 7 lands. Safe.
2. **Annexe 8 must go in via `add_to_catalog`.** `store.writeSlot` rewrites a whole
   slot and deletes anything not in the batch, and the live `senegal` library holds
   ~18 entries authored through the curator loop that exist nowhere in the repo. A
   seed run against it would erase them.
3. Redeploy (this is a code change — `use_rubric` and `evaluate_document` do not exist
   on the running server until then).
4. `use_rubric` the Annexe 8 grid onto the reading Guide's TLM, then `publish_draft`.

## Deliberately not built

- **`log_evaluation`** — persisting scores against a document version, so you could
  show the MoE a signed Annexe 8 and track whether v3 scored better than v1. Real, but
  it is the next commit, not this one.
- **Gating approval on a passing score.** Nothing blocks on a rubric result today.
- **Annexe 7 G–L as a separate instrument.** Those sections need people, not a tool.
