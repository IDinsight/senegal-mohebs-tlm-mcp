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

// WORKSPACE (senegal): Annexe 8's illustration + socio-cultural criteria — WHAT an image
// depicts (diversity, gender, disability, life skills), not how it is rendered.
// Deliberately NOT folded into the shared art-style formatter: that entry's verbatim block
// is pasted unchanged into every image prompt, and representation policy would bloat the
// very thing whose value is being copied word for word.
// Its rules are per-BOOK, not per-image — asking whether ONE picture respects religious
// diversity is meaningless — so the spec tells the caller to plan the scenes first and
// verify once the support is complete.
const ILLUSTRATION_REPRESENTATION_FORMATTER = {
  nodes: [
    {
      id: "formatter-illustration-representation",
      labels: [ROUTINE_LABEL],
      properties: {
        description: "Représentation et inclusion dans les illustrations (images)",
        metadata: {
          role: "instructional-routine",
          catalogKind: "formatter",
          summary: "Ce que les illustrations doivent montrer : diversité sénégalaise, équité de genre, handicap, absence de stéréotypes, compétences de vie. Reprend les critères socioculturels de l'Annexe 8. À appliquer par-dessus le formatter de style graphique partagé, qui régit le rendu.",
        },
      },
    },
    {
      id: "formatter-illustration-representation-diversite",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "Diversité et réalités sénégalaises",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "Diversité — ces règles s'apprécient à l'échelle du SUPPORT ENTIER, pas image par image. Avant de générer les illustrations d'un support, dresser la liste des scènes prévues et répartir la diversité sur l'ensemble ; la vérifier une fois le support complet.",
          "Cadre de vie : sur l'ensemble d'un support, les scènes se répartissent entre milieu urbain et milieu rural, sans qu'aucun des deux ne représente moins d'un tiers des scènes situées. Varier concrètement les décors : cour d'école, marché, champ, quartier, bord de mer, cour familiale.",
          "Diversité ethnique et coutumière : varier les carnations, les coiffures et les tenues au sein d'une même scène de groupe, en s'appuyant sur les réalités sénégalaises. Les tenues traditionnelles et les tenues contemporaines coexistent ; ne pas cantonner le traditionnel au rural.",
          "Diversité religieuse : lorsqu'un marqueur religieux apparaît, le traiter comme un élément ordinaire du décor, jamais comme le sujet de l'image, et veiller à ce qu'un même support n'en montre pas d'un seul type. En cas de doute, préférer une scène sans marqueur religieux plutôt qu'une scène déséquilibrée.",
          "Symboles et sites : lorsqu'un lieu ou une figure célèbre du Sénégal est représenté, le figurer fidèlement et respectueusement, sans caricature ni détournement humoristique.",
        ].join("\n\n"),
      },
    },
    {
      id: "formatter-illustration-representation-genre",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "Genre, handicap et stéréotypes",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "Équité de genre, à l'échelle du support : filles et garçons, femmes et hommes apparaissent en nombre comparable (ni l'un ni l'autre sous 40 % des personnages humains), et en particulier parmi les personnages qui AGISSENT — celui qui résout, dirige, explique ou décide dans une scène.",
          "Rôles : ne jamais réserver un rôle à un sexe. Une fille peut mener le jeu, réparer, compter, conduire ; un garçon peut cuisiner, balayer, prendre soin d'un plus petit, pleurer. Sur l'ensemble d'un support, au moins un tiers des scènes de tâche domestique montre un personnage masculin, et au moins un tiers des scènes de responsabilité ou de savoir montre un personnage féminin.",
          "Handicap : au moins un personnage porteur de handicap apparaît de façon récurrente dans chaque support, comme membre ordinaire du groupe — il participe, joue et réussit. Ne jamais faire du handicap le sujet de l'image, ni l'objet de la leçon, ni un motif de pitié ou d'assistance.",
          "Stéréotypes : aucune image ne fait reposer son sens sur une caractéristique attribuée à un groupe (le rural naïf, le citadin aisé, la fille timide). En cas de doute sur une scène, se poser la question : si l'on échangeait le sexe, le milieu ou l'origine des personnages, l'image garderait-elle exactement le même sens ? Si non, la scène est à revoir.",
        ].join("\n\n"),
      },
    },
    {
      id: "formatter-illustration-representation-competences-de-vie",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "Compétences de vie et environnement",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "Compétences de vie — à faire porter par le DÉCOR et par ce que font les personnages, jamais par une morale ajoutée. L'image montre le bon geste ; elle ne le commente pas.",
          "Environnement : aucune scène ne banalise un geste nuisible (déchet jeté au sol, robinet laissé ouvert, arbre coupé sans raison). Sur l'ensemble d'un support, plusieurs scènes montrent un geste favorable rendu ordinaire : ramasser, planter, arroser, trier, refermer.",
          "Hygiène et sécurité : partout où le geste a naturellement sa place, le représenter correctement — se laver les mains avant de manger, regarder avant de traverser, s'écarter du feu. Ne jamais illustrer un geste dangereux, même pour le dénoncer : un lecteur débutant retient l'image, pas la légende.",
          "Vivre ensemble : privilégier les scènes de coopération, d'entraide et de respect mutuel — partager, écouter celui qui parle, aider un plus jeune, accueillir un nouveau. Les scènes de conflit ne servent que si l'image montre aussi la résolution.",
          "Ces éléments restent au second plan : ils ne doivent jamais détourner l'attention de l'objet d'apprentissage de la page.",
        ].join("\n\n"),
      },
    },
    {
      id: "formatter-illustration-representation-adequation",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "Adéquation au texte et au niveau",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "Adéquation au texte : l'illustration représente ce que le texte de la page dit, sans rien ajouter qui le contredise ni rien montrer que le texte n'évoque pas. Pour un lecteur débutant, l'image est un appui au décodage : un détail non mentionné devient une fausse piste.",
          "Une image n'anticipe jamais la chute d'un récit ni la réponse d'un exercice.",
          "Adéquation au niveau : plus le niveau est bas, plus l'image est dépouillée — livrets 1 à 3 : un seul sujet clairement détouré, décor minimal, pas plus de trois personnages ; à partir du niveau 6 et dans le Cahier de récits, une scène complète est admise.",
          "Attrait et caractère ludique : chaque illustration comporte au moins un élément vivant — un mouvement, un regard, une expression, un petit détail à trouver — pour que l'élève ait envie de la regarder. Une image plate et purement descriptive ne satisfait pas ce critère.",
          "Variété : ne pas répéter le même cadrage ni la même composition d'une page à l'autre. Alterner les plans (personnage seul, groupe, objet isolé, scène large) au fil du support.",
        ].join("\n\n"),
      },
    },
  ],
  relationships: [
    { id: "formatter-illustration-representation-haspart-1", type: "hasPart", start: "formatter-illustration-representation", end: "formatter-illustration-representation-diversite", properties: {} },
    { id: "formatter-illustration-representation-haspart-2", type: "hasPart", start: "formatter-illustration-representation", end: "formatter-illustration-representation-genre", properties: {} },
    { id: "formatter-illustration-representation-haspart-3", type: "hasPart", start: "formatter-illustration-representation", end: "formatter-illustration-representation-competences-de-vie", properties: {} },
    { id: "formatter-illustration-representation-haspart-4", type: "hasPart", start: "formatter-illustration-representation", end: "formatter-illustration-representation-adequation", properties: {} },
  ],
};

// ── Authored rubric entries (evaluation grids) ───────────────────────────────
// A rubric is a catalog entry (kind=rubric) shaped like a nested routine, one level
// deeper than a formatter: entry → SECTIONS (each weighted) → CRITERIA (Materials
// holding the measurable indicator). use_rubric relabels a copy to Rubric/
// RubricSection/RubricCriterion under a document's TLM, and evaluate_document reads
// it back. Sections and criteria are written as plain JS below and expanded by
// `rubricEntry`, because a grid is ~30 criteria and the literal form would bury the
// content under boilerplate.
//
// Content convention (as elsewhere in this file): English comments, French content.

// Expand a grid into the raw {nodes, relationships} envelope assembleCatalog takes.
// `sections` is [{ slug, name, weight?, criteria: [{ slug, name, indicator }] }];
// positions are the array order, so re-ordering the source re-orders the grid.
function rubricEntry({ id, name, summary, scale, sections }) {
  const nodes = [{
    id,
    labels: [ROUTINE_LABEL],
    properties: {
      description: name,
      metadata: { role: "instructional-routine", catalogKind: "rubric", summary, scale },
    },
  }];
  const relationships = [];

  sections.forEach((section, sectionIndex) => {
    const sectionId = `${id}-${section.slug}`;
    nodes.push({
      id: sectionId,
      labels: [ROUTINE_LABEL],
      properties: {
        description: section.name,
        position: sectionIndex + 1,
        metadata: { role: "instructional-routine", ...(section.weight ? { weight: section.weight } : {}) },
      },
    });
    relationships.push({ id: `${sectionId}-haspart`, type: "hasPart", start: id, end: sectionId, properties: {} });

    section.criteria.forEach((criterion, criterionIndex) => {
      const criterionId = `${sectionId}-${criterion.slug}`;
      nodes.push({
        id: criterionId,
        labels: [MATERIAL_LABEL],
        properties: {
          description: criterion.name,
          materialType: "Reference",
          position: criterionIndex + 1,
          metadata: { role: "instructional-routine-material" },
          content: criterion.indicator,
        },
      });
      relationships.push({ id: `${criterionId}-haspart`, type: "hasPart", start: sectionId, end: criterionId, properties: {} });
    });
  });

  return { nodes, relationships };
}

// SHARED: Annexe 7's scored grid. Only its CONTENT sections (A–F) are here — G–L
// (contrôlabilité, cohérence, adaptation contextuelle, efficience, fiabilité, éthique)
// judge the authoring TOOL and the process, not the material, and stamping them into a
// document-scoped rubric would imply this server can answer them. The kept weights are
// the source document's own, so they total 80%, not 100% — score each section, then
// renormalise over the sections actually judged.
const ANNEXE_7_RUBRIC = rubricEntry({
  id: "rubric-annexe-7-materiels",
  name: "Annexe 7 — Grille d'évaluation des matériels (sections A–F)",
  scale: "0-4",
  summary: [
    "Grille NOTÉE de la qualité didactique d'un matériel produit. Échelle 0 à 4 : 0 = inexistant ou incorrect, 1 = très insuffisant, 2 = acceptable (minimum), 3 = bon, 4 = excellent. Le score global est la moyenne pondérée des sections.",
    "Ne couvre que les sections A à F de l'Annexe 7 — celles qui portent sur le MATÉRIEL. Les sections G à L de la grille d'origine (contrôlabilité, cohérence pédagogique du dispositif, adaptation contextuelle, efficience, fiabilité, éthique et biais) évaluent l'outil de production et son usage : elles se jugent avec des personnes, pas sur un document, et ne figurent donc pas ici.",
    "Les poids retenus sont ceux de la grille d'origine et totalisent 80 % ; renormaliser sur les seules sections évaluées.",
    "Certains indicateurs supposent un test de terrain (taux de compréhension par les élèves, temps de résolution). Ils ne se déduisent pas d'une lecture du document : le déclarer explicitement plutôt que d'inventer une note.",
  ].join("\n\n"),
  sections: [
    {
      slug: "a-pertinence-didactique", name: "A. Pertinence didactique", weight: "20%",
      criteria: [
        { slug: "alignement", name: "Alignement aux objectifs", indicator: "Part des contenus alignés sur les objectifs définis. Vérifier que chaque section du document se rattache à un objectif du programme, et signaler tout contenu orphelin." },
        { slug: "progression", name: "Progression pédagogique", indicator: "Présence d'une gradation claire du simple vers le complexe, observable d'une séance à la suivante." },
        { slug: "explications", name: "Qualité des explications", indicator: "Explications structurées, en étapes explicites — et non un résultat donné sans cheminement." },
        { slug: "exemples", name: "Pertinence des exemples", indicator: "Exemples en lien direct avec la notion enseignée, et non décoratifs ou hors sujet." },
        { slug: "erreurs", name: "Anticipation des erreurs", indicator: "Les erreurs typiques des élèves sont nommées et traitées, pas seulement la démarche correcte." },
      ],
    },
    {
      slug: "b-exactitude", name: "B. Exactitude disciplinaire", weight: "15%",
      criteria: [
        { slug: "contenus", name: "Exactitude des contenus", indicator: "Part d'erreurs détectées ; l'objectif est zéro. Citer chaque erreur relevée avec sa localisation." },
        { slug: "solutions", name: "Rigueur des solutions", indicator: "Les solutions proposées sont complètes et justifiées, non tronquées." },
        { slug: "coherence", name: "Cohérence interne", indicator: "Absence de contradictions entre deux passages du même document (terminologie, valeurs, consignes)." },
      ],
    },
    {
      slug: "c-adaptation-niveau", name: "C. Adaptation au niveau", weight: "10%",
      criteria: [
        { slug: "niveau-cognitif", name: "Niveau cognitif", indicator: "Adéquation avec le niveau cible (par exemple CE1) : ni au-dessous, ni hors de portée." },
        { slug: "complexite", name: "Complexité des tâches", indicator: "Progressivité observable de la difficulté des tâches au fil du document." },
        { slug: "differenciation", name: "Différenciation", indicator: "Des variantes sont proposées (facile / moyen / difficile), ou une remédiation est prévue pour les élèves en difficulté." },
      ],
    },
    {
      slug: "d-gestion-langage", name: "D. Gestion du langage", weight: "15%",
      criteria: [
        { slug: "consignes", name: "Clarté des consignes", indicator: "Taux de compréhension par les élèves (test terrain). Non déductible du seul document : le signaler si aucun test n'est disponible, et juger à défaut la lisibilité des consignes pour l'enseignant." },
        { slug: "simplicite", name: "Simplicité linguistique", indicator: "Longueur moyenne des phrases et vocabulaire contrôlé, adaptés au niveau." },
        { slug: "vocabulaire", name: "Explicitation du vocabulaire", indicator: "Les termes techniques de la discipline sont définis (Annexe 7 : « termes mathématiques »)." },
        { slug: "multilinguisme", name: "Multilinguisme", indicator: "Possibilité L1/L2 (par exemple wolof / français) prise en charge là où le dispositif le prévoit." },
        { slug: "terminologie", name: "Cohérence terminologique", indicator: "Un même objet porte un même nom d'un bout à l'autre : absence de variations confuses." },
      ],
    },
    {
      slug: "e-qualite-taches", name: "E. Qualité des tâches", weight: "10%",
      criteria: [
        { slug: "variete", name: "Variété des exercices", indicator: "Nombre de types d'activités différents proposés ; compter les types, pas les exercices." },
        { slug: "niveau-taches", name: "Niveau cognitif des tâches", indicator: "Part de tâches de réflexion par rapport aux tâches de répétition." },
        { slug: "ancrage", name: "Ancrage réel", indicator: "Présence de contextes réels et familiers aux élèves, plutôt que d'énoncés abstraits." },
      ],
    },
    {
      slug: "f-explication-feedback", name: "F. Explication & feedback", weight: "10%",
      criteria: [
        { slug: "pas-a-pas", name: "Explication pas à pas", indicator: "Les étapes détaillées sont présentes, y compris pour l'enseignant qui remédie." },
        { slug: "feedback", name: "Feedback sur les erreurs", indicator: "Les retours sur erreur sont explicatifs : ils disent pourquoi, pas seulement que c'est faux." },
        { slug: "reformulation", name: "Reformulation", indicator: "Des explications alternatives sont proposées pour l'élève qui n'a pas compris la première." },
      ],
    },
  ],
});

// WORKSPACE (senegal): Annexe 8's approval checklist — the Oui/Non gate an MoE
// reviewer signs before a final support is printed. Deliberately PARTIAL: the rows
// that a formatter already enforces AT GENERATION TIME are not repeated here, namely
// Annexe 8's section C (physical: marges, taille et police de caractères, espacements,
// contraste, pagination, table des matières, repères) and the illustration block
// (diversifiées, attrayantes, ludiques, en adéquation avec les textes, non
// stéréotypées). Those live in the fiche-session layout formatter and the illustration
// formatters — you do not want to generate a support with 9pt text and then tick "Non"
// in a box. What remains is what only a reader of the finished document can answer.
//
// Note the two are not the same instrument: Annexe 7 SCORES quality 0–4, Annexe 8
// GATES approval Oui/Non. A single "Non" blocks; there is no weighted average.
const ANNEXE_8_RUBRIC = rubricEntry({
  id: "rubric-annexe-8-approbation",
  name: "Annexe 8 — Grille d'approbation des supports finaux (critères de jugement)",
  scale: "oui-non",
  summary: [
    "Grille d'APPROBATION, non de notation : chaque critère se répond par Oui ou Non, sans pondération. Tout « Non » est bloquant et doit être listé comme tel, avec la localisation du passage en cause.",
    "Cette grille ne reprend PAS l'intégralité de l'Annexe 8. Les critères physiques (section C : mise en page, marges, taille et police de caractères, espacements, contraste texte-papier, pagination, table des matières, repères) et le bloc sur les illustrations (diversifiées, attrayantes, ludiques, en adéquation avec les textes, non stéréotypées) sont pris en charge en amont par les formatters de mise en page et d'illustration : ils sont satisfaits par construction à la génération, et non vérifiés après coup ici.",
    "Restent ci-dessous les critères qui exigent la lecture du document produit — exactitude, progression, exploitation pédagogique, représentation socioculturelle, langue. Plusieurs ne s'apprécient qu'à l'échelle du SUPPORT ENTIER (équité de genre, diversité géographique) : lire le document en entier avant de répondre.",
    "Support évalué : le support effectivement produit. L'Annexe 8 d'origine vise les Cahiers de récits et les Livrets gradués ; ici, aucun manuel de l'élève n'étant produit, la grille s'applique au Guide de l'enseignant.",
  ].join("\n\n"),
  sections: [
    {
      slug: "a-contenus", name: "A. Contenus",
      criteria: [
        { slug: "couverture", name: "Couverture des objets d'apprentissage", indicator: "Les supports produits contribuent-ils à la couverture de la totalité des objets d'apprentissage programmés ? (À recouper avec review_draft, qui vérifie la même couverture côté graphe.)" },
        { slug: "themes", name: "Conformité aux thèmes", indicator: "Les contenus sont-ils conformes aux thèmes proposés dans les spécifications pédagogiques ?" },
        { slug: "exactitude", name: "Exactitude", indicator: "Les contenus sont-ils exacts — données précises, claires et non sujettes à interprétation — là où cela s'applique ?" },
        { slug: "actualite", name: "Actualité", indicator: "Les contenus reflètent-ils les réalités récentes et l'état des connaissances en apprentissage de la lecture initiale ?" },
      ],
    },
    {
      slug: "b-strategie", name: "B. Stratégie pédagogique",
      criteria: [
        { slug: "progression", name: "Progression", indicator: "Les supports respectent-ils le principe de progression défini dans les spécifications pédagogiques, en présentant des apprentissages significatifs progressifs et illustrés ?" },
        { slug: "integration", name: "Situations d'intégration", indicator: "Présentent-ils des situations significatives d'intégration diverses ?" },
        { slug: "pratique-reguliere", name: "Pratique régulière de la lecture", indicator: "Les supports favorisent-ils la pratique régulière de la lecture ?" },
        { slug: "consolidation", name: "Révision et consolidation", indicator: "Les supports favorisent-ils la révision ou la consolidation de la lecture ?" },
        { slug: "vecu", name: "Appel au vécu de l'élève", indicator: "Les possibilités d'exploitation pédagogique font-elles appel au vécu de l'élève ?" },
        { slug: "acquis", name: "Consolidation des acquis", indicator: "Font-elles appel à la consolidation des acquis ?" },
        { slug: "reinvestissement", name: "Réinvestissement des acquis", indicator: "Font-elles appel au réinvestissement des acquis ?" },
      ],
    },
    {
      slug: "c-evaluation", name: "C. Évaluation",
      criteria: [
        { slug: "formative", name: "Évaluation formative", indicator: "Le support comprend-il des questions permettant l'évaluation formative des élèves ? (Annexe 8 : pour le cahier de récits et les livrets gradués des niveaux 6 et 7.)" },
      ],
    },
    {
      slug: "d-realites-socioculturelles", name: "D. Respect des réalités socio-culturelles sénégalaises",
      criteria: [
        { slug: "situations-diversifiees", name: "Diversité des situations", indicator: "Les supports présentent-ils différents types de textes et d'illustrations dans des situations diversifiées respectant les réalités sénégalaises ?" },
        { slug: "geographique", name: "Diversité géographique", indicator: "La diversité géographique (zone urbaine et zone rurale) est-elle respectée ? À apprécier sur l'ensemble du support, en comptant les scènes situées." },
        { slug: "religieuse", name: "Diversité religieuse", indicator: "La diversité religieuse est-elle respectée ?" },
        { slug: "ethnique", name: "Diversité ethnique et coutumière", indicator: "La diversité ethnique et coutumière est-elle respectée ?" },
        { slug: "symboles", name: "Symboles, personnages et sites célèbres", indicator: "Les supports respectent-ils les symboles liés aux personnages ou sites célèbres du Sénégal ?" },
      ],
    },
    {
      slug: "e-genre-inclusion", name: "E. Genre et inclusion sociale",
      criteria: [
        { slug: "handicap", name: "Personnages porteurs de handicap", indicator: "Les personnages porteurs de handicap sont-ils représentés de façon respectueuse et dans des rôles valorisants ? Répondre Non si aucun n'apparaît : l'absence est elle-même un manquement." },
        { slug: "equite", name: "Représentation équitable des deux sexes", indicator: "Les personnages des deux sexes sont-ils représentés de façon équitable ? Compter les personnages sur tout le support, et regarder en particulier qui agit, décide et explique." },
        { slug: "respect-realites", name: "Représentation respectueuse", indicator: "Les personnages des deux sexes sont-ils représentés de façon respectueuse des réalités sénégalaises ?" },
        { slug: "stereotypes", name: "Absence de stéréotypes", indicator: "Les comportements de l'un ou de l'autre sexe sont-ils dénués de stéréotypes ?" },
      ],
    },
    {
      slug: "f-competences-de-vie", name: "F. Compétences de vie",
      criteria: [
        { slug: "environnement", name: "Préservation de l'environnement", indicator: "Les contenus des textes et des illustrations sont-ils respectueux de la préservation de l'environnement ?" },
        { slug: "developpement-durable", name: "Développement durable", indicator: "Suscitent-ils des actions favorisant le développement durable (santé et bien-être, entrepreneuriat, citoyenneté, environnement, etc.) ?" },
        { slug: "citoyennete", name: "Devoirs et droits", indicator: "Incitent-ils l'élève à accomplir ses devoirs envers sa communauté et à jouir de ses droits ?" },
        { slug: "respect", name: "Respect de soi et des autres", indicator: "Suscitent-ils chez l'élève le renforcement des capacités de respect de soi et des autres ?" },
        { slug: "hygiene-securite", name: "Hygiène et sécurité", indicator: "Suscitent-ils le renforcement des capacités de respect des règles d'hygiène et de sécurité ?" },
      ],
    },
    {
      slug: "g-langue", name: "G. Critères linguistiques et typographiques",
      criteria: [
        { slug: "normes", name: "Normes linguistiques", indicator: "Les normes linguistiques sont-elles respectées — textes exempts de fautes, de coquilles, etc. ?" },
        { slug: "niveau-langage", name: "Langage adapté au niveau", indicator: "Le support utilise-t-il un langage adapté au niveau scolaire de l'élève ?" },
        { slug: "richesse", name: "Richesse du vocabulaire", indicator: "Le vocabulaire utilisé est-il riche et diversifié ?" },
        { slug: "typographie", name: "Règles typographiques", indicator: "Les règles typographiques dans la présentation sont-elles respectées ? (La mise en page elle-même relève du formatter de layout, pas de ce critère.)" },
      ],
    },
  ],
});

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

// DANGER — do NOT run this against the LIVE `senegal` catalog. store.writeSlot
// rewrites the WHOLE slot: it upserts these ids and DELETES every node not in the
// batch. The live senegal library holds ~18 entries authored through add_to_catalog
// that exist nowhere in this file, so a seed run would erase them (and duplicate the
// entries whose live ids were minted rather than slugged). Deliver a new senegal entry
// with add_to_catalog through the curator loop; use this script for `_shared`, or only
// after folding the live entries in. The `--dry-run` flag is safe.
//
// The catalog namespaces to seed. `sources` are subject graphs (scraped for their
// ROUTINE subtrees only); `authored` are the formatter literals, added whole. Keeping
// them separate is what stops a subject graph's attached formatter copies (from
// use_formatter) being re-scraped into the catalog as duplicate entries. The SHARED
// library holds the cross-tenant entries (every subject's routines + the
// workspace-agnostic formatters); each workspace library holds entries local to that
// tenant (its subject-specific layout formatters).
const catalogs = [
  { namespace: SHARED_CATALOG_NAMESPACE, adapterId: "shared-routine-catalog", sources: subjectSources, authored: [HOUSE_STYLE_FORMATTER, HOUSE_ART_STYLE_FORMATTER, ANNEXE_7_RUBRIC] },
  {
    namespace: catalogNamespace("senegal"),
    adapterId: "senegal-catalog",
    sources: [],
    authored: [MATHS_ILLUSTRATION_FORMATTER, ILLUSTRATION_REPRESENTATION_FORMATTER, ANNEXE_8_RUBRIC],
  },
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
