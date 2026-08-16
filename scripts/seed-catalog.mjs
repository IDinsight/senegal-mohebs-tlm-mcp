#!/usr/bin/env node
/*
 * Idempotent seed for the reusable-spec CATALOGS (cross-context libraries, not subject
 * graphs). It seeds two namespaces, both with the same slot/pointer discipline as
 * seed-kg-store (slot "a", fixed ids, so a re-seed overwrites the same docs):
 *   - the SHARED library (SHARED_CATALOG_NAMESPACE) — every subject's routine subtrees
 *     (extracted from the installed sources; non-routine content dropped) plus the
 *     workspace-agnostic formatters (house style + Senegalese art style); and
 *   - each workspace library (catalogNamespace(<workspace>)) — entries local to that
 *     tenant, i.e. its subject-specific layout formatters (senegal: the CI-maths
 *     pupil-manual illustration layout).
 *
 * Today only CI maths carries routines (the two "Fiche de leçon" + "Structure d'un
 * chapitre" entries), so that is what seeds; any subject that later gains routines is
 * picked up automatically.
 *
 * Usage:
 *   npm run build                         # compile TS to dist/ first
 *   node scripts/seed-catalog.mjs         # seed the catalog (Firestore)
 *   node scripts/seed-catalog.mjs --dry-run   # in-memory store; no writes, prints a summary
 *
 * Env: same Firebase auth as seed-kg-store (SERVICE_ACCOUNT_KEY_PATH / _JSON,
 * FIREBASE_STORAGE_BUCKET, TLM_SOURCES_DIR, TLM_BUCKET_PREFIX).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(REPO, "dist");
if (!existsSync(DIST)) {
  console.error("seed-catalog: dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const { createMemoryKgStore, createFirestoreKgStore } = await import(new URL("../dist/kg-store/index.js", import.meta.url));
// The KG lives only in the store now, so the routine subtrees are scraped from
// the committed test/fixtures/ graphs (the same graphs, as plain data). Scan the
// fixtures tree for every <workspace>/<grade>/<subject>/knowledge_graph.json.
const FIXTURES = resolve(REPO, "test/fixtures");
function fixtureGraphs() {
  const out = [];
  if (!existsSync(FIXTURES)) return out;
  for (const ws of readdirSync(FIXTURES)) {
    for (const grade of readdirSync(resolve(FIXTURES, ws))) {
      for (const subject of readdirSync(resolve(FIXTURES, ws, grade))) {
        const p = resolve(FIXTURES, ws, grade, subject, "knowledge_graph.json");
        if (existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}
const { assembleCatalog, catalogNamespace, SHARED_CATALOG_NAMESPACE, CATALOG_ROOT_ID } = await import(new URL("../dist/kg-recipes/index.js", import.meta.url));

const dryRun = process.argv.slice(2).includes("--dry-run");

// ── Authored formatter entries ───────────────────────────────────────────────
// Formatters are catalog entries (kind=formatter) whose Material holds a house-style
// spec the generator applies. They are authored DATA (not server mechanism), so they
// live here in the seed tooling and are fed to assembleCatalog as `authored` entries —
// each a raw InstructionalRoutine + Material subtree, `catalogKind:"formatter"` on the
// entry making list_catalog report kind "formatter". The catalog machinery in
// src/kg-recipes/catalog.ts only re-homes and reads them; the content is here.
const ROUTINE_LABEL = "InstructionalRoutine";
const MATERIAL_LABEL = "Material";

// The verbatim art-look block — must reach an image prompt UNCHANGED (pasting the same
// paragraph at the start of every generate_image call is what keeps a whole book, and
// every book in the workspace, looking like one hand). Kept as its own constant so the
// Material below and any check assert against the same text.
const HOUSE_ART_STYLE_BLOCK = [
  "STYLE GRAPHIQUE : illustration vectorielle 2-D à plat, façon dessin animé, pour",
  "un manuel scolaire pour enfants. Contours brun foncé, nets et d'épaisseur",
  "régulière autour de chaque personnage et objet ; aplats de couleurs vives et",
  "saturées avec un ombrage cel simple à deux tons (une couleur de base plus une",
  "ombre légèrement plus foncée, à bord net) ; formes nettes et épurées ; palette",
  "gaie et lumineuse. Décor sénégalais — sol sableux et chaud, ciel bleu clair,",
  "vêtements colorés en wax ; personnages aux proportions rondes et amicales, aux",
  "visages simples et expressifs ; personnages sénégalais à la peau foncée. Le",
  "rendu doit évoquer un manuel de lecture / une planche de bande dessinée",
  "d'Afrique de l'Ouest.",
  "À éviter explicitement : texture aquarelle ou peinture au pinceau, dégradés",
  "doux, traits esquissés ou irréguliers, texture crayon ou pastel, réalisme",
  "photographique, rendu 3-D, couleurs ternes ou désaturées.",
].join("\n");

// SHARED: the docx house style (palette/typography/page/compression). Subject-agnostic.
const HOUSE_STYLE_FORMATTER = {
  nodes: [
    {
      id: "formatter-house-style",
      labels: [ROUTINE_LABEL],
      properties: {
        description: "Style maison MOHEBS (docx)",
        metadata: { role: "instructional-routine", catalogKind: "formatter", summary: "À appliquer à chaque .docx généré, pour une présentation cohérente d'une matière à l'autre." },
      },
    },
    {
      id: "formatter-house-style-spec",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "Spécification du style maison",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "Style maison de tout .docx généré — à appliquer de façon cohérente d'une matière à l'autre.",
          "Palette : vert principal #2E7D5E (titres, en-têtes, étiquettes clés) ; vert clair #E8F3EE (fonds des lignes d'en-tête de section/étape) ; gris #666666 (sous-titres, lignes de méta) ; orange #D4812A (étiquettes d'encadré/de repère) ; texte blanc #FFFFFF sur les fonds verts.",
          "Typographie : Calibri partout ; corps de texte 11–12 pt ; en-têtes en gras (titre du document ~17–20 pt, section ~13–14 pt).",
          "Page : A4 portrait ; marges ≈1,7 cm haut/bas, 2,0 cm gauche/droite (≈17 cm de largeur utile) ; interligne compact (interligne simple, espacement après minimal, aucun paragraphe d'espacement vide).",
          "Images : insérer un JPEG réduit — redimensionner à ~1600 px sur le grand côté, qualité ~82 ; viser quelques Mo par document, jamais un PNG en pleine résolution.",
          "La mise en page propre à une matière (tableaux à boîtes d'étapes, colonnes bilingues, ratios des images d'activité) ne fait PAS partie de ce style partagé — elle reste dans le prompt de la matière ou dans un formatter d'espace de travail.",
        ].join("\n\n"),
      },
    },
  ],
  relationships: [
    { id: "formatter-house-style-haspart", type: "hasPart", start: "formatter-house-style", end: "formatter-house-style-spec", properties: {} },
  ],
};

// SHARED: the reusable Senegalese children's-textbook art look, split out of CI-maths's
// chapter prompt. Subject-agnostic — carries the verbatim ART STYLE block + the two
// consistency rules about the *look* (prepend it; opening scene is the master that fixes
// cast+palette, later images are independent compositions, not crops). Ratios/layout/sizes
// are NOT here — those are a subject's presentation (see MATHS_ILLUSTRATION_FORMATTER).
const HOUSE_ART_STYLE_FORMATTER = {
  nodes: [
    {
      id: "formatter-art-style",
      labels: [ROUTINE_LABEL],
      properties: {
        description: "Style graphique de manuel scolaire sénégalais (images)",
        metadata: { role: "instructional-routine", catalogKind: "formatter", summary: "À placer en tête de chaque prompt d'image généré, pour que toutes les illustrations partagent un même style maison." },
      },
    },
    {
      id: "formatter-art-style-spec",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "Spécification du style graphique",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "Style graphique maison de toute illustration générée — à appliquer de façon cohérente au sein d'un ouvrage et d'une matière à l'autre.",
          "PLACER CE BLOC TEL QUEL au DÉBUT de chaque prompt generate_image / edit_image, puis ajouter ensuite la description propre à la scène ou à l'activité. Ne pas le paraphraser — c'est la reprise mot pour mot qui empêche le générateur de dériver (par ex. vers l'aquarelle). Si le style maison change un jour, ne modifier que ce bloc.",
          "```\n" + HOUSE_ART_STYLE_BLOCK + "\n```",
          "Cohérence de la scène maîtresse : la scène d'ouverture/maîtresse du document est dessinée en premier et fixe la distribution des personnages et la palette précise ; toute autre image est une composition INDÉPENDANTE dans le même univers (mêmes personnages, objets, décor, style graphique) — et NON un recadrage, un zoom ou un détourage littéral de la scène d'ouverture. Une référence/un stimulus dont une image a besoin est une nouvelle représentation dans ce style, pas une portion d'une autre image.",
        ].join("\n\n"),
      },
    },
  ],
  relationships: [
    { id: "formatter-art-style-haspart", type: "hasPart", start: "formatter-art-style", end: "formatter-art-style-spec", properties: {} },
  ],
};

// WORKSPACE (senegal): the CI-maths pupil-manual illustration layout — subject/deliverable
// specific (the maths MCQ activity image + its answer-by-looking layout), so it seeds into
// the senegal workspace catalog, not the shared one. Presentation only (Bucket B): ratios,
// the two activity layouts, A/B/C badge styling, on-page sizes — nothing pedagogical.
const MATHS_ILLUSTRATION_FORMATTER = {
  nodes: [
    {
      id: "formatter-maths-illustration",
      labels: [ROUTINE_LABEL],
      properties: {
        description: "CI maths — mise en page des illustrations du manuel de l'élève (images)",
        metadata: { role: "instructional-routine", catalogKind: "formatter", summary: "Ratios d'image, disposition des panneaux d'activité et tailles d'affichage pour le manuel de l'élève de CI maths. À appliquer par-dessus le formatter de style graphique partagé." },
      },
    },
    {
      id: "formatter-maths-illustration-spec",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "Spécification de la mise en page des illustrations",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "Mise en page des illustrations du manuel de l'élève de CI maths — à appliquer par-dessus le formatter de style graphique partagé (le rendu) et le style maison partagé (palette/polices/compression).",
          "Ratios selon le type d'image : scène d'ouverture (situation d'amorce) = 16:9 (une scène pleine et immersive) ; bandeau de notion « Je retiens » = 21:9 (large et court) ; chaque image d'activité = 21:9. Les images d'activité sont larges et courtes pour que le livre imprimé reste compact (une contrainte de coût d'impression de l'État).",
          "Deux dispositions d'activité, toutes deux en 21:9. (a) COMPARAISON AUTONOME — une large rangée de trois panneaux A / B / C, chaque panneau contenant tout ce qui est comparé. (b) AVEC RÉFÉRENCE — une image gauche/droite : le stimulus/la référence étiqueté occupe le QUART GAUCHE (sa propre bande à fin cadre, avec une courte étiquette en français, par ex. « Le grand panier », pour qu'il se lise comme l'élément de comparaison et non comme un quatrième choix) ; les trois options A / B / C sont sur une rangée horizontale dans les 3/4 DROITS (gauche→A, centre→B, droite→C).",
          "Règles de pastilles et de lisibilité (les images sont petites sur la page, le contenu doit donc être grand) : afficher les lettres A / B / C en grand et en gras dans des pastilles nettement colorées — A rouge, B bleu, C vert — chacune occupant une part notable de son panneau et lisible à quelques cm de haut. Garder les objets de chaque panneau grands et peu encombrés (environ 5 au maximum, faciles à dénombrer). Les courtes étiquettes d'objets restent petites et secondaires par rapport aux repères A / B / C.",
          "Tailles d'affichage sur la page (seules les dimensions d'affichage sont propres à la matière ; la résolution en pixels + la compression JPEG viennent du style maison partagé) : scène d'ouverture ~14–16 cm de large ; chaque image d'activité exactement 5,25 cm de haut (≈12,3 cm de large en 21:9), centrée ; le bandeau « Je retiens » occupe toute la largeur du texte mais reste court.",
          "Le bilan du chapitre n'a AUCUNE image propre — il renvoie les élèves, en mots, à l'image de la scène d'ouverture déjà présente en tête de chapitre ; ne rien générer pour lui.",
        ].join("\n\n"),
      },
    },
  ],
  relationships: [
    { id: "formatter-maths-illustration-haspart", type: "hasPart", start: "formatter-maths-illustration", end: "formatter-maths-illustration-spec", properties: {} },
  ],
};

// Read every installed source's raw graph (assembleCatalog keeps only the routine
// subtrees), to be spliced under the SHARED catalog with the shared formatters.
const subjectSources = [];
let subjectHashes = "";
for (const bundlePath of fixtureGraphs()) {
  const bytes = readFileSync(bundlePath);
  subjectHashes += createHash("sha256").update(bytes).digest("hex");
  const parsed = JSON.parse(bytes.toString("utf8"));
  subjectSources.push({ nodes: parsed.nodes ?? [], relationships: parsed.relationships ?? parsed.edges ?? [] });
}

// The catalog namespaces to seed. `sources` are subject graphs (scraped for their
// ROUTINE subtrees only); `authored` are the formatter literals, added whole. Keeping
// them separate is what stops a subject graph's attached formatter copies (from
// use_formatter) being re-scraped into the catalog as duplicate entries. The SHARED
// library holds the cross-tenant entries (every subject's routines + the
// workspace-agnostic formatters); each workspace library holds entries local to that
// tenant (its subject-specific layout formatters).
const catalogs = [
  { namespace: SHARED_CATALOG_NAMESPACE, adapterId: "shared-routine-catalog", sources: subjectSources, authored: [HOUSE_STYLE_FORMATTER, HOUSE_ART_STYLE_FORMATTER] },
  { namespace: catalogNamespace("senegal"), adapterId: "senegal-catalog", sources: [], authored: [MATHS_ILLUSTRATION_FORMATTER] },
];

const store = dryRun ? createMemoryKgStore() : createFirestoreKgStore();
let failed = false;

for (const { namespace, adapterId, sources, authored } of catalogs) {
  const { nodes, edges } = assembleCatalog(sources, namespace, CATALOG_ROOT_ID, authored);
  const routineCount = nodes.filter((n) => (n.labels ?? []).includes("InstructionalRoutine")).length;
  const entryCount = edges.filter((e) => e.type === "hasPart" && e.from === CATALOG_ROOT_ID).length;
  // Hash the actual bytes going into this catalog: the subject-bundle hashes plus the
  // authored formatter sources, so a formatter edit changes the stamp too.
  const contentHash = createHash("sha256").update(subjectHashes + JSON.stringify(sources) + JSON.stringify(authored)).digest("hex");
  const meta = { contentHash, seededAt: new Date().toISOString(), adapterId, nodeCount: nodes.length, edgeCount: edges.length };

  console.error(`seed-catalog: backend=${store.kind}, ns='${namespace}', ${entryCount} entries, ${nodes.length} nodes, ${edges.length} edges.`);
  try {
    const existing = await store.readPointer(namespace);
    await store.writeSlot(namespace, "a", { nodes, edges, meta });
    await store.ensurePointer(namespace, "a");
    const after = await store.readPointer(namespace);
    const note = existing && after && after.publishedSlot !== "a"
      ? ` (WARNING: publishedSlot is '${after.publishedSlot}', not 'a' — this re-seed wrote a non-published slot)`
      : "";
    console.error(`seed-catalog: OK '${namespace}' — ${entryCount} entries, ${routineCount} routine nodes, hash=${contentHash.slice(0, 12)}…${note}`);
  } catch (e) {
    console.error(`seed-catalog: FAILED '${namespace}' — ${(e && e.message) || e}`);
    failed = true;
  }
}

if (failed) process.exit(2);
console.error("seed-catalog: done.");
