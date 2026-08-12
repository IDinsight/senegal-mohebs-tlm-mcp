# Live KG explorer — findings & decisions (Step 0)

> **Status: Historical / partly superseded.** The central decision here — ship a **spine-only** store — was later reversed: the store now holds the FULL Learning-Commons graph (framework/derived nodes + `supports`/`relatesTo` edges included), and the explorer surfaces it. See [`../technical-reference.md`](../technical-reference.md) "Data-scope finding" and CLAUDE.md "Full-graph store" for the current design. Also SUPERSEDED: the subject-specific views (thematique/planification) and role-based legend described here — the explorer now follows the **LC ontology only** (nodes coloured by LC label; two generic views: containment hierarchy + by-label). See CLAUDE.md "Full-graph store". This note is kept for the original rationale and the feature-by-feature analysis.

> **Update:** the raw field names below are pre-convergence (camelCase `chapitreNum`/`osTexte`). The KG is now snake_case with an LC metadata scheme (`metadata.role`/`metadata.order`/`metadata.en`); `src/kg-export.ts` reads the current names. Kept as a historical record.

**Status:** report before build · **Date:** 2026-07-31 · **Author:** (curator tooling)

This note answers the Step-0 questions for the read-only "live KG explorer" (a hosted
static page that fetches the published graph from a new `/kg` export endpoint on the MCP
server). It is written to be read *before* any code lands, because the data-scope finding
(§1) decides whether the endpoint reproduces the rich uploaded explorer or a spine-centric
view — and that is the user's call.

Everything below §1 is **verified against live Firestore** (published slot, `senegal-ci-maths`
project), not inferred from the source bundle.

---

## 1. Data scope — what is actually in the PUBLISHED Firestore graph

Firestore does **not** store the raw Learning-Commons graph. The seed pipeline
(`scripts/seed-kg-store.mjs`) runs each subject adapter's `parse()` → a *normalized*
`CurriculumModel` → `serializeModel()` → generic `kg_nodes` / `kg_edges` docs. So the store
holds only what the normalized model keeps: the **curriculum spine**, plus every raw source
field carried along inside `properties.raw`.

### Verified live snapshot (published slot `a`, no draft in either namespace)

| namespace | nodes | node types | edges | edge types |
|---|---|---|---|---|
| `ci/maths` | 328 | `chapter` 25 · `lesson` 112 · `component` 80 · `task` 111 | 362 | `hasChild` 345 · `buildsTowards` 17 |
| `ce1/reading` | 1178 | `week` 21 · `standard` 126 · `component` 1031 | 513 | `hasChild` 513 |

- Node top-level properties (both namespaces): `code, title, text, order, isAssessment, raw`.
- `ci/maths` `raw.*` keys: `sourceKey, statementType, statementCode, domaine, domaine_en,
  palier, semaine, chapitreNum, chapitreTitre, chapitreTitre_en, osTexte, osTexte_en,
  examples, examples_en, aptitudeCI, aptitudeCI_en, commentaireProgression(_en), reference,
  statut, statut_en, receGroupe, receNiveau, receResultat, normalizedStatementType, …`.
- `ci/maths` **`raw.sourceKey` values present: all seven** — `RECE, Rwanda P1, Kenya KICD,
  South Africa DBE, Bridges G1, MOHEBS CI, Learning Commons CCSS-M`.
- `ci/maths` `raw.statementType` values present: only spine subtypes —
  `Chapitre, OS (Objectif Spécifique), OS (Objectif Spécifique) — intégration du palier`.
- `ce1/reading` `raw.*` keys: `description, strand, palier, semaine, genre, statementCode,
  caseUuid, metadata, …`. No `sourceKey`, no `statementType` (CE1 reading has neither).

### What is IN the store (reproducible live)
The whole **spine**: for CI maths `chapter → lesson → component(LearningComponent) →
task(Curriculum)` via `hasChild`, plus `chapter → chapter` `buildsTowards` progression; for
CE1 reading `week → standard → component`. Chapters/weeks are roots. A handful of nodes are
legitimately orphaned (CI maths: 3 lessons, 10 components, 7 tasks; CE1 reading: 644 components) —
components/tasks the source graph never linked into the spine.

### What is NOT in the store (present only in the old HTML / raw bundle)
The raw bundle *does* contain the full scaffolding (verified: 1 `StandardsFramework`, 182
`StandardsFrameworkItem` incl. the RECE + six "Cadre dérivé"/"Famille de composants"
branches, 265 `supports`, 6 `relatesTo`). The adapter drops all of it. So the store lacks:

1. **Framework / provenance branches as navigable nodes** — no `StandardsFramework` root, no
   `Domaine` / `Palier` / `Semaine` grouping nodes, no `Cadre RECE` branch, no six
   derived-source family branches. (Domaine/Palier/Semaine survive as *properties*, not nodes.)
2. **Cross-link edges** — `supports` (skill→standard, task→skill alignment) and `relatesTo`
   (Level-1 ↔ Level-2 contrast) are gone. Only tree edges (`hasChild`) + `buildsTowards` remain.

### What this means for the uploaded explorer's three views + modal

| Explorer feature | Reproducible live from spine + `raw.*`? |
|---|---|
| **Chapitres** view (Domaine → Chapitre → OS) | ✅ Domaine synthesized from `raw.domaine`; Chapitre→OS is the stored spine |
| **Planification** view (Palier → Semaine → OS) | ✅ Already synthesized client-side from `pal`/`sem` (both survive in `raw`) |
| **Thématique** view, core drilldown (Domaine → Chapitre → OS → composant → tâche) | ✅ This IS the stored spine |
| Thématique view's **RECE branch + 6 derived-source family branches** (parallel roots) | ❌ Those nodes were dropped |
| **Source-filter chips** (per-leaf `srcKey`) | ✅ All 7 `raw.sourceKey` tags present on component/task nodes |
| Modal: Context, OS text, examples, statut, source, progression comment | ✅ From `raw.*` |
| Modal: parent / children / buildsTowards | ✅ From stored edges |
| Modal: "components supporting this lesson", "tasks for this lesson" | ✅ Re-expressed from the lesson→component→task spine |
| Modal: "RECE competency exercised", "Level-1↔2 contrast", chapter-level alignment backlinks | ❌ Depend on dropped `supports`/`relatesTo` edges |

**Verdict:** In the task's dichotomy this is **SPINE-ONLY** — but a *rich* spine. All three
CI maths views, the deep OS→composant→tâche drilldown, and the source chips are fully live; the
gaps are (a) the RECE + derived-source branches as separate roots, and (b) a few modal
cross-reference blocks that need the `supports`/`relatesTo` edges.

### The decision (user's call)
- **(a) Ship spine-only now.** Meets the acceptance bar ("identical spine at minimum") and
  delivers ~90% of the explorer live, with zero graph reshape. The two gaps above simply
  don't render.
- **(b) Ingest the missing framework/derived nodes + cross-link edges first.** Requires
  extending the CI maths adapter's `parse()`/serialize to keep the grouping/family nodes and to
  store `supports`/`relatesTo` as edges (additive new node kinds + edge types), then a
  **re-seed**. This is a modest, additive graph-content change (a Step-0 non-goal unless the
  user opts in) — it makes Firestore a more faithful mirror of the raw KG and lights up the
  two gaps. Bigger scope; separate decision.

**Recommendation: (a).** It is truly live, reproduces the bulk of what the expert uses, and
keeps the store/adapter untouched. (b) is a clean follow-up if the RECE/derived branches or
the alignment/contrast modal blocks prove necessary.

---

> **Decisions (2026-07-31):** (1) **ship spine-only now**; (2) access = **Supabase login**;
> (5) hosting = **Firebase Hosting default site** (`senegal-ci-maths.web.app` /
> `.firebaseapp.com`). (3) server-side display-JSON and (4) `meta.viewConfig` proceed as
> recommended.

## 2. Access model — DECIDED: Supabase login

The `/mcp` surface is an OAuth resource server verifying Supabase JWTs. Curriculum content is
not PII/PHI but is internal work product, so a fully public link is a deliberate choice, not a
default.

- **Recommended:** reuse Supabase auth — the static page runs a small supabase-js login
  (mirroring the existing `/oauth/consent` page) and sends the JWT as `Authorization: Bearer`
  to `/kg`; the endpoint verifies it with the same JWKS verifier as `/mcp`. Consistent with
  the rest of the system, no new secret.
- **Lighter:** a single shared access token (env var) the endpoint checks and the page prompts
  for once. Minimal, but a shared secret.
- **Public:** no auth. Simplest; exposes internal work product on an open URL.

## 3. Transform location — RECOMMENDED, proceeding unless objected

Server returns **display-JSON** (server-side raw-LC → display transform). The frontend stays a
pure renderer, decoupled from the raw-LC / normalized shape. Matches the task's own
recommendation and the "capabilities-as-mirror" pattern already in the codebase.

## 4. View-config source — RECOMMENDED, proceeding unless objected

The `/kg` response carries `meta.viewConfig` declaring which views apply for that namespace
(data-driven). `ci/maths` declares its three rich views; `ce1/reading` (and any KG without a
rich config) falls back to the generic raw-LC view (node-type → outgoing relations). The
frontend is generic; each KG declares its own views.

## 5. Hosting + CORS + namespace enumeration — PENDING origin confirmation

- **Hosting:** Firebase Hosting on the `senegal-ci-maths` project (not yet configured). Default
  origins would be `https://senegal-ci-maths.web.app` and `https://senegal-ci-maths.firebaseapp.com`.
  The `/kg` CORS allowlist will name exactly the confirmed origin(s).
- **Namespace enumeration:** `GET /kg/namespaces` lists every namespace that has a
  `kg_pointers` doc (data-driven — a newly seeded KG appears in the selector automatically),
  filtered to those with a published slot. Confirmed present today: `ci/maths`, `ce1/reading`.

---

## 6. raw-LC → display-schema field mapping (the transform to implement)

Display node schema the explorer's views/modal consume (edges as `{s, t, r}`), mapped from the
stored `{type, properties:{code,title,text,order,isAssessment, raw:{…}}}`:

| display field | source | notes |
|---|---|---|
| `id` | `node.id` | verbatim |
| `label` | derived from `type` | CI maths: chapter/lesson→`StandardsFrameworkItem`, component→`LearningComponent`, task→`Curriculum`; CE1 reading: standard→`StandardsFrameworkItem`, week→grouping, component→`LearningComponent` |
| `nt` | `raw.normalizedType` / `raw.contentType` | task Activity/Assessment classification for the stats chip |
| `st` / `st_en` | `raw.statementType` / `raw.statementType_en` | spine subtype |
| `code` | `properties.code` (`raw.statementCode`) | e.g. "Leçon 64" |
| `desc` / `desc_en` | `properties.text` / `raw.osTexte`,`raw.description` (+ `_en`) | display label |
| `ex` / `ex_en` | `raw.examples` / `raw.examples_en` | |
| `grp`/`res`/`niv` | `raw.receGroupe` / `raw.receResultat` / `raw.receNiveau(Scolaire)` | |
| `apt`/`apt_en` | `raw.aptitudeCI` / `raw.aptitudeCI_en` | |
| `comm`/`comm_en` | `raw.commentaireProgression` / `_en` | |
| `pal` / `sem` | `raw.palier` / `raw.semaine` | drive the synthesized Planification view |
| `chapN` / `chapT`/`chapT_en` | `raw.chapitreNum` / `raw.chapitreTitre` / `_en` | |
| `dom` / `dom_en` | `raw.domaine` / `raw.domaine_en` | drives synthesized Domaine roots |
| `os` / `os_en` | `raw.osTexte` / `raw.osTexte_en` | |
| `src` / `ref` / `statut` | `raw.source` / `raw.reference` / `raw.statut` | |
| `srcKey` | `raw.sourceKey` | source-filter chips derive from the set present |

**Edges.** Emit stored `hasChild`/`buildsTowards` as `{s:from, t:to, r:type, o:order}`. The forked
frontend follows `hasChild` directly for the OS→composant→tâche drilldown (the spine stores that
hierarchy as `hasChild`), so no synthetic `supports` edges are needed — a change from the original
explorer, which keyed off `supports` because its inline DATA encoded that level as `supports`.
Domaine/Palier/Semaine grouping is **synthesized client-side** from node properties (`dom`, `pal`,
`sem`) by the `grouped-spine` view primitive, exactly as the uploaded explorer already synthesizes
Palier/Semaine. Under option (b) the dropped `supports`/`relatesTo` edges and framework/derived
nodes would instead come straight from the store.

## 7. Endpoint shape (proposed)

- `GET /kg/namespaces` → `{ namespaces: [{ ns, grade, subject, label }] }` from `kg_pointers`.
- `GET /kg?ns=<namespace>` → `{ nodes:[…display nodes…], edges:[{s,t,r}], meta:{ ns, label,
  publishedSlot, seededAt, counts, viewConfig, sources:[…srcKeys present…] } }`, resolved to the
  **published** slot only (no draft leakage), CORS-enabled for the hosting origin, auth per §2.
- Purely additive to `http.ts`; existing MCP tools/auth unchanged.
