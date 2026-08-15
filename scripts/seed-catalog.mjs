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
  "ART STYLE: flat 2-D vector cartoon illustration for a children's educational",
  "textbook. Bold, even dark-brown outlines of consistent weight around every",
  "character and object; flat, saturated colour fills with simple two-tone cel",
  "shading (one base colour plus one slightly darker, hard-edged shadow); crisp",
  "clean shapes; bright cheerful palette. Senegalese setting — warm sandy ground,",
  "clear blue sky, colourful wax-print clothing; friendly rounded character",
  "proportions with simple, expressive faces; dark-skinned Senegalese characters.",
  "The look should resemble a printed West-African primary-school reader / comic",
  "panel.",
  "Explicitly avoid: watercolour or painterly brush texture, soft gradients,",
  "sketchy or uneven linework, pencil or crayon texture, photographic realism,",
  "3-D rendering, muted or desaturated colours.",
].join("\n");

// SHARED: the docx house style (palette/typography/page/compression). Subject-agnostic.
const HOUSE_STYLE_FORMATTER = {
  nodes: [
    {
      id: "formatter-house-style",
      labels: [ROUTINE_LABEL],
      properties: {
        description: "MOHEBS house style (docx)",
        metadata: { role: "instructional-routine", catalogKind: "formatter", summary: "Apply to every generated .docx for a consistent look across subjects." },
      },
    },
    {
      id: "formatter-house-style-spec",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "House style spec",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "House style for every generated .docx — apply consistently across subjects.",
          "Palette: primary green #2E7D5E (titles, headings, key labels); light green #E8F3EE (section/step header fills); grey #666666 (subtitles, meta lines); orange #D4812A (callout/cue labels); white #FFFFFF text on green fills.",
          "Typography: Calibri throughout; body 11–12 pt; headings bold (document title ~17–20 pt, section ~13–14 pt).",
          "Page: A4 portrait; margins ≈1.7 cm top/bottom, 2.0 cm left/right (≈17 cm content width); compact spacing (single line spacing, minimal space-after, no blank spacer paragraphs).",
          "Images: embed a downscaled JPEG — resize to ~1600 px on the long edge, quality ~82; target a few MB per document, never a full-resolution PNG.",
          "Subject-specific layout (step-box tables, bilingual columns, activity image ratios) is NOT part of this shared style — it stays in the subject's prompt or a workspace formatter.",
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
        description: "Senegalese children's-textbook art style (images)",
        metadata: { role: "instructional-routine", catalogKind: "formatter", summary: "Prepend to every generated image prompt so all illustrations share one house look." },
      },
    },
    {
      id: "formatter-art-style-spec",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "Art style spec",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "House art style for every generated illustration — apply consistently across a book and across subjects.",
          "PREPEND THIS BLOCK VERBATIM at the START of every generate_image / edit_image prompt, then add the scene- or activity-specific description after it. Do not paraphrase it — verbatim reuse is what stops the generator drifting (e.g. into watercolour). If the house look ever changes, edit only this block.",
          "```\n" + HOUSE_ART_STYLE_BLOCK + "\n```",
          "Master-scene consistency: the deliverable's opening/master scene is drawn first and fixes the cast of characters and the specific palette; every other image is an INDEPENDENT composition in the same world (same characters, objects, setting, art style) — NOT a crop, zoom-in, or literal cut-out of the opening scene. A reference/stimulus an image needs is a fresh depiction in this style, not a slice of another image.",
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
        description: "CI maths — pupil-manual illustration layout (images)",
        metadata: { role: "instructional-routine", catalogKind: "formatter", summary: "Image aspect ratios, activity-panel layout and on-page sizes for the CI maths pupil manual. Apply on top of the shared art-style formatter." },
      },
    },
    {
      id: "formatter-maths-illustration-spec",
      labels: [MATERIAL_LABEL],
      properties: {
        description: "Illustration layout spec",
        materialType: "Reference",
        metadata: { role: "instructional-routine-material" },
        content: [
          "Illustration layout for the CI maths pupil manual — apply on top of the shared art-style formatter (the look) and the shared house style (palette/fonts/compression).",
          "Aspect ratios by image type: opening scene (situation d'amorce) = 16:9 (a full, immersive scene); \"Je retiens\" concept strip = 21:9 (wide and short); every activity image = 21:9. Activity images are wide and short so the printed book stays compact (a government printing-cost constraint).",
          "Two activity layouts, both 21:9. (a) SELF-CONTAINED COMPARISON — one wide row of three panels A / B / C, each panel containing everything being compared. (b) REFERENCE-BASED — a left/right image: the labelled stimulus/reference occupies the LEFT QUARTER (its own thin-framed band with a short French label, e.g. \"Le grand panier\", so it reads as the thing to compare against, not a fourth choice); the three options A / B / C sit in a horizontal row across the RIGHT 3/4 (left→A, centre→B, right→C).",
          "Badge & legibility rules (the images are small on the page, so content must be large): render the A / B / C letters big and bold in clearly coloured badges — A red, B blue, C green — each taking a meaningful share of its panel and readable at a few cm tall. Keep each panel's objects large and uncluttered (about 5 or fewer, easy to count). Short object labels stay small and secondary to the A / B / C markers.",
          "On-page display sizes (only the display dimensions are subject-specific; the underlying pixel resolution + JPEG compression come from the shared house style): opening scene ~14–16 cm wide; every activity image exactly 5.25 cm high (≈12.3 cm wide at 21:9), centred; the \"Je retiens\" banner spans the full text width but stays short.",
          "The chapter bilan has NO image of its own — it sends pupils back in words to the opening-scene image already at the top of the chapter, so generate nothing for it.",
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
