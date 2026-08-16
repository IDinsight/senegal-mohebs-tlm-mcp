## KG explorer (read-only live viewer)

A hosted static page that lets a CI maths/CE1 reading expert pick a knowledge graph and explore it
**live** — sourced from Firestore's PUBLISHED slot, not a baked snapshot. It is **read-only**:
it never writes, never sees drafts, and does not touch the MCP tools or their auth. Editing
stays in the MCP curator tools. See `docs/design-notes/kg-explorer-findings.md` for the design rationale and
the data-scope finding.

Two pieces: a read-only **export endpoint** (companion routes on the same Cloud Run service,
`src/kg-export.ts` + routes in `src/http.ts`) and the **hosted explorer** (`frontend/explorer/`,
a React + TypeScript app — Vite, Tailwind CSS, Lucide icons — that builds to
`frontend/explorer/dist` and is served by Firebase Hosting). It is a component-based port of the
original single-file page: same look, interactions, and data contract.

### Endpoint contract

All routes are additive; the MCP `/mcp` surface is unchanged. Reads resolve to the pointer's
`publishedSlot` only (a curator's draft never leaks here until they publish).

- `GET /kg/config` — **public**. `{ supabaseUrl, supabaseAnonKey, authRequired }` so the static
  page can drive its own Supabase login without baking deployment config into the HTML.
- `GET /kg/namespaces` — **auth-gated**. `{ namespaces: [{ ns, grade, subject, label:{fr,en} }] }`.
  Lists every installed context that has a published pointer, so a newly seeded KG appears in the
  selector automatically.
- `GET /kg?ns=<namespace>` — **auth-gated**. The published **display-JSON** for one namespace:

  ```jsonc
  {
    "nodes": [ { "id", "label", "kind", "nt", "st","st_en", "code", "desc","desc_en",
                 "dom","pal","sem","chapN","chapT", "src","ref","statut", "srcKey", ... } ],
    "edges": [ { "s", "t", "r", "o" } ],           // r ∈ {hasChild, buildsTowards}; o = sibling order
    "meta": {
      "ns", "label", "publishedSlot", "generatedAt",
      "counts": { "nodes", "edges", "byKind" },
      "sources": ["RECE","Rwanda P1", ...],        // distinct srcKeys present → source-filter chips
      "viewConfig": { "views": [ { "id","label","shape","params" } ] }
    }
  }
  ```

**Auth** (decision: Supabase login). When `SUPABASE_URL` is set, `/kg/namespaces` and `/kg`
require a valid Supabase Bearer JWT — the same trust channel as `/mcp`. The static page runs a
small `supabase-js` email/password login (mirroring `/oauth/consent`) and sends the token. In
`ALLOW_UNAUTHENTICATED=1` (local only) the routes are open.

**Public explorer** (`KG_EXPLORER_PUBLIC=1`). Opens the read-only explorer to anyone: the `/kg`
read routes stop requiring a JWT and `/kg/config` reports `authRequired:false`, so the static
page skips its login gate. Affects **only** the `/kg` read surface — `/mcp` stays JWT-gated. This
exposes every seeded namespace's published graph to anyone with the URL (CORS does not restrict
non-browser clients), so set it only when public read access is intended. Unset (the default)
keeps the explorer login-gated.

**CORS.** Allow-listed to the Firebase Hosting origin(s); override with `KG_ALLOWED_ORIGINS`
(comma-separated). `localhost`/`127.0.0.1` are always allowed for local dev. The deployed page
does not actually need CORS — Firebase Hosting **rewrites** `/kg/**` → the Cloud Run service
(`firebase.json`), so the browser calls same-origin and Hosting proxies to Cloud Run (the JWT
passes through). CORS covers direct/local access.

### The raw-LC → display transform

The store holds a NORMALIZED graph (generic `{type, properties:{code,title,text,order,isAssessment,raw}}`)
in the converged snake_case LC metadata scheme. `toDisplayNode` maps each stored node to the
explorer's display schema:

| display field | source | display field | source |
|---|---|---|---|
| `label` | derived from `kind` | `dom` | domaine node's name, **propagated** to its content-axis descendants server-side |
| `kind` | store `type` (`domaine`/`chapter`/`week`/`lesson`/`standard`/`component`/`task`) | `pal` | `raw.palier` / `raw.metadata.palier` (weeks) |
| `code` | `properties.code` (`raw.statementCode`) | `ord` | `properties.order` / `raw.metadata.order` (domaine: canonical index) |
| `desc`/`desc_en` | `properties.text`/`title` · `raw.description`/`raw.osTexte` · `_en` from `raw.metadata.en.*` | `os`/`os_en` | `raw.osTexte` / `raw.metadata.en.os_texte` |
| `st`/`st_en` | `raw.statementType` (category) / `raw.metadata.en.statement_type` | `src`/`ref`/`statut` | `raw.source`/`reference`/`statut` |
| `nt` | `raw.normalizedType` / `raw.normalizedStatementType` / `raw.contentType` | `srcKey` | `raw.sourceKey` |
| `ex`/`ex_en`, `apt`, `comm` | `raw.examples` / `raw.aptitude_ci` / `raw.commentaire_progression` (`_en` under `raw.metadata.en`) | `strand`,`genre` | `raw.statement_type` (reading standards only), `raw.metadata.genre` (weeks) |

Edges are the stored `hasChild` + `buildsTowards` as `{s,t,r,o}`. Domaine / Semaine / Chapitre are now
**real nodes** joined by `hasChild` edges (two axes: `domaine → LessonGrouping → lesson` content,
`week → lesson` schedule; the lesson then `supports` its spine `expectation`/OS) — no client-side
grouping synthesis; the views walk the actual node hierarchy.

### Data-driven views (`meta.viewConfig`)

The frontend is generic and renders whatever views `meta.viewConfig` declares — no per-namespace
`if` anywhere. Two view **shapes**:

- `grouped-spine` — anchors on `anchorKind` nodes (optionally bucketed by `groupBy` props; empty
  `groupBy` = the anchors ARE the roots), then walks the `expandEdge` (`hasChild`) subtree.
- `node-type` — the generic floor, works for ANY namespace: each node type → its nodes → their
  outgoing relations.

Both subjects declare the same three tabs: **thematic**, **planification**, **generic**.

- **Thematic** — by the subject's thematic categories. Maths anchors on the real `domaine` node and
  walks `hasChild` (Domaine → Chapitre → OS → composant → tâche). Reading has no seeded grouping nodes,
  so it groups standards by their language-tool **strand** (`groupBy: [strand]`, `order` = the six
  outils de langue) → the standards → their components.
- **Planification** — `Palier → Semaine → …`: anchor `week`, `groupBy: [palier]`, expand `hasChild`.
  Reading weeks carry their palier; maths weeks borrow it from a scheduled lesson (derived in
  `exportNamespace`, see below).
- **Generic** — `node-type`.

`buildViewConfig` picks the thematic anchor by which kinds are present (`domaine` → maths hierarchy;
else `standard` → reading strand grouping). The backend is covered by `src/__tests__/kg-export.test.ts`; the
frontend (`frontend/explorer/`) is data-driven and adapts — **re-verify in-browser after
`gcloud run deploy` (the /kg endpoint) + `firebase deploy --only hosting`.**

**Explorer post-processing** (`exportNamespace`, display-only — never touches the store): (1) domaine
**colour** is propagated down the content axis so a whole subtree shares its domaine's colour; (2) a
maths **week palier** is derived from its scheduled lessons; (3) a **navigable-spine filter** keeps
only nodes reachable from a root (`week`/`domaine`) via `hasChild`. Reading's parse is now
spine-scoped (its `postParse` keeps only the six language-tool week-standards + their components), so
this filter is a no-op there; it still trims maths's few borrowed-framework component/task leftovers
(pre-existing — the maths parse maps every `LearningComponent`/`Curriculum` node). A safety net that
de-noises the explorer without a re-seed.

### Adding a new KG

Seed it into Firestore (see [Seed](store.md#seed)). It then appears in the selector automatically. If its
data has the CI maths-shaped fields it gets the rich views; otherwise it renders via the generic
`node-type` view — no frontend change. To give a differently-shaped KG its own rich views, extend
`buildViewConfig` in `src/kg-export.ts` with a new detection + a new view `shape` in the frontend
(the view-derivation builders live in `frontend/explorer/src/lib/graphModel.ts`).

### Data-scope finding (what's in the graph)

**The store now holds the FULL Learning-Commons graph** (superseding the earlier spine-only
design). The seed pipeline still runs each adapter's `parse()`, but `parseGraph` echoes the raw
graph onto the model (`CurriculumModel.rawGraph`), and `serializeModel` persists EVERY raw node and
EVERY raw edge verbatim (`ci/maths`: 501 nodes / 877 edges; `ce1/reading`: 1968 / 2244):

- **Spine nodes** (the ones `parse()` keeps — `ci/maths` domaine→chapter→lesson (+aligned
  expectation)→component, `ce1/reading` week→day(Jour 1–5)→session-lesson→standard→component)
  carry `spine: true` plus their normalized fields.
- **Non-spine nodes** (the RECE + six other "Composants dérivés" frame SFIs, their derived
  `LearningComponent`s, and the illustrative `Activity`s hanging off them) carry `spine: false`
  and only `properties.raw` — kept purely for faithful re-export.
- **Edges** keep their real canonical LC type — `hasChild` (standards hierarchy), `hasPart`
  (content containment), `supports` (component→SFI), `hasEducationalAlignment` (content→SFI),
  `relatesTo`, `buildsTowards` — with a `seq` recording raw order. In the explorer, both
  `supports` and `hasEducationalAlignment` fold (reversed) into the display containment tree.

**Reads.** Hydration rebuilds the raw envelope (`toRawEnvelope`) and runs
`adapter.parse` to derive the spine model. Non-spine nodes are dropped by `parse` at read time.

**Export.** Because the store IS the raw graph, `toRawEnvelope(storedNodes, storedEdges)`
reproduces the raw `{ nodes, relationships }` envelope — that is what `export-kg` writes and
`import-kg` reads back. The explorer surfaces the whole graph: spine categories plus a
neutral `framework` legend bucket for non-spine nodes and the `supports`/`relatesTo` cross-links.
See `docs/design-notes/kg-explorer-findings.md` §1 for the original spine-only analysis (superseded).

### Build & deploy the explorer

The explorer is a Vite/React app under `frontend/explorer/`. `firebase.json`'s `predeploy` hook
runs the build automatically, so a plain deploy is enough:

```bash
firebase deploy --only hosting --project senegal-ci-maths    # → https://senegal-ci-maths.web.app
```

That runs `npm --prefix frontend/explorer ci && npm --prefix frontend/explorer run build`
(output → `frontend/explorer/dist`, the folder Firebase serves) before uploading.

`firebase.json` rewrites `/kg/**` to the `senegal-mohebs-tlm` Cloud Run service (region
`europe-west1`). Local dev: `cd frontend/explorer && npm install && npm run dev`, then either run the
server locally (`node dist/http.js` with `ALLOW_UNAUTHENTICATED=1`) and let the Vite proxy forward
`/kg` (override the target with `KG_API=http://localhost:<port>`), or point the app straight at the
deployed endpoint with `?api=https://…run.app`.
