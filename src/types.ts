// ─────────────────────────────────────────────────────────────────────────────
// Deliverables & history
// ─────────────────────────────────────────────────────────────────────────────

// A deliverable key identifies one kind of document a subject produces
// (e.g. "manual", "lessons"). It is an open string drawn from the active
// SubjectAdapter's deliverable list — NOT a fixed union — because the set of
// deliverables varies per grade/subject. Kept as a named alias for readability.
export type DeliverableKey = string;

// Back-compat alias. Historically a closed "manual" | "lessons" union; now open.
export type DocType = DeliverableKey;

export type CharacterRef = {
  name: string;
  type?: string;
  role?: string;
  description?: string;
};

export type DocumentContent = {
  summary?: string;
  characters?: CharacterRef[];
  exampleDomains?: string[];
  conceptsCovered?: string[];
  terminologyUsed?: string[];
};

export type HistoryEntry = {
  id: string;                 // `${scope}:${deliverableKey}` (CI maths: `${chapter}:manual`)
  chapter: number;            // scope value; numeric for every subject shipped so far
  type: DeliverableKey;
  relPath: string;
  md5: string;
  updated: string;
  source: "pipeline" | "parsed";
  recordedAt: string;
  content: DocumentContent;
};

export type HistoryFile = { version: 2; entries: HistoryEntry[] };

export type StoredObject = {
  relPath: string;
  md5: string | null;
  updated: string | null;
};

export type DiscoveredDoc = {
  id: string;
  chapter: number;
  type: DeliverableKey;
  relPath: string;
  md5: string | null;
  updated: string | null;
};

export interface StorageAdapter {
  listDocuments(): Promise<StoredObject[]>;
  getObjectMd5(relPath: string): Promise<string | null>;
  downloadDocx(relPath: string): Promise<Buffer>;
  createUploadUrl(relPath: string): Promise<{ url: string; objectKey: string; contentType: string; expiresAt: string }>;
  createDownloadUrl(relPath: string): Promise<{ url: string; objectKey: string; expiresAt: string; exists: boolean }>;
  // Preview output path (Phase 3). Signs a short-lived write+read URL pair for a
  // throwaway .docx under the SIBLING previews/ prefix — never the canonical
  // documents/ keyspace, never logged to history. Optional on the interface so
  // storage backends that don't support previews (and test stubs) can omit it;
  // the preview tool checks for its presence. `objectKey` proves segregation
  // (it lives under previews/, invisible to reconcile/list_documents).
  createPreviewUpload?(relPath: string): Promise<{ uploadUrl: string; downloadUrl: string; objectKey: string; contentType: string; expiresAt: string }>;
  readHistory(): Promise<HistoryFile | null>;
  writeHistory(h: HistoryFile): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized curriculum model — the shared shape every subject's graph is parsed
// into, so the rest of the server never touches raw graph JSON. General enough
// for a numbered chapter/lesson list AND for an edge-tree of paliers/skill-areas.
// See docs/multi-subject-architecture.md §5.1.
// ─────────────────────────────────────────────────────────────────────────────
export type CurriculumUnit = {
  id: string;                          // stable id from the graph
  kind: string;                        // subject-defined role: "chapter","lesson","component","task",…
  code: string | null;                 // statement_code / statementCode
  title: string | null;                // short display label
  text: string | null;                 // full statement text (description)
  order: number | null;                // metadata.order, or derived ordinal within siblings
  parentId: string | null;
  childIds: string[];                  // ordered children
  buildsTowards: string[];             // unit ids (empty if the subject has no progression)
  buildsFrom: string[];
  isAssessment: boolean;               // generalizes the CI maths "bilan"
  properties: Record<string, unknown>; // subject-specific passthrough
  labels?: string[];                   // raw LC node top-level labels, preserved verbatim for faithful re-export
};

// The raw graph a model was parsed from, echoed verbatim. Present when the
// model came from `parseGraph` (bundle read or hydration); it is what lets the
// store persist EVERY node + edge (not just the spine) for a faithful,
// re-exportable Learning-Commons copy. Node/edge shape mirrors the raw envelope.
export type RawGraphSnapshot = {
  nodes: Array<{ id: string; labels?: string[]; properties?: Record<string, unknown> }>;
  relationships: Array<{ id: string; type: string; start: string; end: string; properties?: Record<string, unknown> }>;
};

export interface CurriculumModel {
  roots: string[];                             // top-level unit ids
  byId: Map<string, CurriculumUnit>;
  unitsOfKind(kind: string): CurriculumUnit[];
  childrenOf(id: string): CurriculumUnit[];
  rawGraph?: RawGraphSnapshot;                 // the source graph, echoed for faithful full-graph storage
}

// ─────────────────────────────────────────────────────────────────────────────
// Deliverables + capabilities — axes 2–3. §5.3.
// ─────────────────────────────────────────────────────────────────────────────
export type DeliverableSpec = {
  key: DeliverableKey;                       // replaces the old DocType enum value
  label: string;                             // human name, e.g. "Manuel de l'élève"
  scopeKind: string;                         // which unit-kind ONE document covers
  classify: (filename: string) => boolean;   // recognize an uploaded file as this deliverable
  dependsOn: DeliverableKey[];               // deliverables required first ([] = standalone)
  promptFile: string | null;                 // generation prompt basename in the subject folder
  pathHint?: string;                         // optional relPath convention for uploads
};

export type Capabilities = {
  exampleDomainRotation: boolean;   // CI CI maths storybook variety; false for CE1 reading
  characterConsistency: boolean;    // CI maths; false for CE1 reading
};

// ─────────────────────────────────────────────────────────────────────────────
// SubjectAdapter — the single per-(grade, subject) module the rest of the
// server dispatches to. Consolidates what used to be three separate concepts
// (CurriculumAdapter — raw parser, SubjectCurriculum — presenter, and
// SubjectProfile — generation-context + deliverables + capabilities) into
// one behavior module. Deliberately BEHAVIOR ONLY: no schema, no LC
// property/edge/cardinality declarations, no integrity rules. Write-safety
// rules live later, in the write tools — not here.
//
// Common core every adapter implements:
//   - raw-schema knowledge (detect + parse) — the only place that touches raw
//     graph JSON. Storage round-trip is handled generically on top of the
//     parsed model by curriculum/store-bridge.ts (serializeModel /
//     deserializeToModel), so no serialize/deserialize methods hang off the
//     adapter;
//   - LC → friendly projection (listUnits / slice / progression /
//     requiredCoverage / scopeValues), rendered from the parsed CurriculumModel;
//   - generation-context assembly (buildGenerationContext), owned by the
//     subject because generation semantics — characters, domains, dependencies
//     — are subject-specific;
//   - deliverables and capabilities declarations.
//
// Optional subject-specific functions (declared on the interface but not every
// adapter implements them). Present only when the corresponding capability is
// enabled; gated at the tool boundary in src/server/*.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Wording aliases for `upsert_property` (#10). Maps a logical wording key
 * a curator would ask about (`"title"`, `"text"`, `"title_en"`, `"text_en"`)
 * to the concrete `StoredNode.properties` paths that back it for a given
 * node kind. When both a normalized field (e.g. `title`) and its raw
 * source (`raw.description`) hold the same wording, the adapter lists
 * BOTH here so one curator call updates them together — the "call twice
 * or drift" trap doesn't reach the curator's mental model.
 *
 * Paths are dot-notation relative to `StoredNode.properties`, e.g.
 * `"title"` or `"raw.description"`. The mutation validates every path
 * against a central safety allowlist regardless — a rogue adapter cannot
 * expand the editable surface by declaring a path outside the pilot.
 *
 * Empty declaration (`{}`) is legitimate for a subject whose adapter
 * doesn't yet expose editable wording.
 */
export type WordingAliases = {
  [nodeKind: string]: {
    [logicalKey: string]: readonly string[];
  };
};

/**
 * STRUCTURAL aliases (#14) — the exact same shape as `WordingAliases`, but for
 * a curated set of STRUCTURAL properties (a chapter's number, a lesson's
 * within-chapter position, a lesson's chapter-membership number) rather than
 * wording. Kept a distinct type (not just `WordingAliases`) so the two never
 * blur: wording is edited by `upsert_property`, structural keys are edited only
 * by the composite recipes, and each has its OWN central safety allowlist in
 * kg-store. Values these keys carry are NUMERIC (order/number), unlike the
 * strings wording carries. Declare only the keys a subject's recipes need.
 */
export type StructuralAliases = WordingAliases;

/**
 * The subject vocabulary the curriculum recipes (#14) need to operate without
 * baking CI CI maths knowledge into the subject-agnostic kg-store. A recipe reads
 * this off the active adapter (like `upsert_property` reads `wordingAliases`)
 * and passes it through as an argument. A subject that declares NO
 * `recipeProfile` simply has no recipes (the CE1 CE1 reading adapter, today).
 *
 * The recipes reference well-known LOGICAL key names ("number" on a chapter;
 * "chapterNumber" / "position" on a lesson; "title" / "text" wording) and rely
 * on `structuralAliases` / `wordingAliases` to resolve them to storage paths —
 * so the only genuinely subject-specific vocabulary that lives here is the node
 * kinds, the container edge type, and where an "assessment" flag is stored.
 */
export type RecipeProfile = {
  chapterKind: string;          // e.g. "chapter" — the container a lesson belongs to
  lessonKind: string;           // e.g. "lesson"  — the child a chapter holds
  containerEdge: string;        // e.g. "hasChild" — the id-based backbone edge chapter→lesson
  assessmentProperty: string;   // e.g. "isAssessment" — node property flagging the bilan
};

/**
 * The Learning-Commons identity fields a recipe stamps onto a node it CREATES,
 * so an authored node is a faithful LC node (survives a re-parse / re-export)
 * rather than a "half" node carrying only wording + number. Essentially the
 * inverse of the parse descriptor's `roleToKind`: one entry per created
 * `CurriculumUnit.kind`. Optional on the adapter — a subject with no recipes
 * (hence no created nodes) omits it.
 *
 * `statementType` is either a constant (a maths chapter is always "Chapitre")
 * or INHERITED: a maths lesson's strand is a denormalized copy of its domaine's
 * name, so we take the title of the nearest container-ancestor of the named
 * kind. When the ancestor can't be resolved (e.g. a lesson seeded under a
 * brand-new chapter not yet linked to a domaine) the recipe falls back to an
 * existing sibling's value, then to leaving it blank with a warning.
 */
export type LcStamp = {
  labels?: string[];                    // → StoredNode.labels (top-level, e.g. ["StandardsFrameworkItem"])
  role?: string;                        // → raw.metadata.role
  normalizedStatementType?: string;     // → raw.normalized_statement_type
  statementType?: string | { inheritTitleFromAncestorKind: string };  // → raw.statement_type
};
export type LcNodeTemplate = Record<string, LcStamp>;   // keyed by CurriculumUnit.kind

/**
 * A read-only view of the raw graph (nodes + edges, no storage slot tag) that
 * the coverage hook inspects. Structurally identical to the kg-store's
 * `MutationGraph` / `Omit<StoredNode,"slot">`, but declared here so `types.ts`
 * (a leaf) doesn't import from `kg-store`. The kg-store's own graph type is a
 * structural match, so the framework can pass its post-apply graph straight in.
 */
export type GraphNodeView = { id: string; type: string; namespace: string; properties: Record<string, unknown> };
export type GraphEdgeView = { id: string; type: string; from: string; to: string; namespace: string; properties: Record<string, unknown> };
export type GraphView = { nodes: GraphNodeView[]; edges: GraphEdgeView[] };

export interface SubjectAdapter {
  readonly grade: string;
  readonly subject: string;
  readonly id: string;                          // stable adapter id, e.g. "ci-maths/nodes-relationships-v1"
  readonly deliverables: DeliverableSpec[];
  readonly capabilities: Capabilities;
  /**
   * The wording paths a curator may edit via `upsert_property` (#10). Each
   * entry names a node kind, then the logical wording keys available on
   * that kind and the storage paths each key updates atomically. See
   * `WordingAliases`. Declare `{}` for a subject with no editable wording.
   */
  readonly wordingAliases: WordingAliases;

  /**
   * STRUCTURAL edit aliases (#14) — the curated structural keys a curator may
   * change on EXISTING nodes through the composite recipes (a chapter's number,
   * a lesson's position and chapter-membership number). Optional: a subject
   * with no recipes omits it. Each logical key resolves to storage paths that
   * are validated against kg-store's `STRUCTURAL_EDIT_SAFE_PATHS` allowlist, so
   * a careless adapter cannot widen the editable surface. See `StructuralAliases`.
   */
  readonly structuralAliases?: StructuralAliases;

  /**
   * The curriculum vocabulary the recipes (#14) bind to. Optional — declaring
   * it is what makes the composite recipes (add_lesson / add_chapter /
   * move_lesson / split_chapter / renumber) AVAILABLE for this subject. A
   * subject that omits it has wording + raw structural verbs but no recipes.
   * See `RecipeProfile`.
   */
  readonly recipeProfile?: RecipeProfile;

  /**
   * The LC identity fields to stamp onto recipe-created nodes so they are
   * faithful LC nodes (see `LcNodeTemplate`). Optional and paired with
   * `recipeProfile` — a subject with recipes declares one so its created
   * chapters/lessons round-trip through the LC parser. A subject that omits it
   * still creates nodes, but they carry only wording + number (the pre-#labels
   * behavior).
   */
  readonly lcNodeTemplate?: LcNodeTemplate;

  /**
   * Coverage / consistency WARNINGS for a proposed graph state (#13). Optional
   * — an adapter with no completeness expectations omits it. Returns
   * human-readable warnings (NEVER errors: warnings inform the reviewer and
   * never block confirmation or publish). Called by the mutation framework on
   * a dry-run's post-apply graph and by `diff_draft` on the whole draft.
   *
   * This is where UNIT-SHAPED rules live — "this chapter has no lessons", "no
   * bilan", "this lesson's number disagrees with the chapter it's linked to".
   * The adapter is the only layer that knows what a unit IS for its subject,
   * so the subject-agnostic `validateStructural` (which does the universal,
   * id-based referential checks) never carries any of this. Reusable helpers
   * for the subject-neutral shapes (empty container, multi-parent) live in
   * `curriculum/coverage.ts`; subject-specific rules (bilan, number drift) are
   * written here in the adapter.
   */
  coverageWarnings?(graph: GraphView): string[];

  // Raw envelope → normalized CurriculumModel. Owns all raw-schema knowledge
  // (envelope layout, endpoint keying, node taxonomy). detect() is the schema
  // guard set_context runs against the KG before activating a context.
  detect(raw: unknown): boolean;
  parse(raw: unknown): CurriculumModel;

  // LC → friendly projection. Return shapes are subject-specific.
  listUnits(): unknown[];
  slice(scope: number | string): unknown | null;
  progression(scope: number | string): unknown;
  requiredCoverage(scope: number | string): unknown[];
  scopeValues(): Array<number | string>;

  // Pre-generation payload. `model` is an OPTIONAL pre-resolved CurriculumModel
  // to build the context from instead of the adapter's default (published)
  // model — the seam preview_generation uses to generate from a DRAFT-resolved
  // model (Phase 3) without touching the published read path. When omitted, the
  // adapter resolves its own (published) model exactly as before, so existing
  // callers (get_generation_context) are unaffected.
  buildGenerationContext(scope: number | string, deliverableKey: DeliverableKey, model?: CurriculumModel): Promise<unknown>;

  // Optional, capability-gated at the tool boundary.
  suggestFreshDomain?(): Promise<unknown>;
  domainUsage?(): Promise<unknown>;
}
