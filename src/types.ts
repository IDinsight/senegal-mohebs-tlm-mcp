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
  id: string;                 // `${scope}:${deliverableKey}` (CI maths: `${unit}:manual`)
  unit: number;               // scope value (CI maths: chapter number; CE1 reading: week); numeric for every subject shipped so far
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
  unit: number;
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
// See docs/design-notes/multi-subject-architecture.md §5.1.
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

// The composite curriculum recipes are now GENERIC verbs (add_node / move_node /
// reposition / set_content) that live in the `kg-recipes` module and derive a
// created node's identity from the graph itself. There is no per-subject
// `RecipeProfile` / `StructuralAliases` / `LcNodeTemplate` anymore — an adapter
// declares only its `wordingAliases` (for `upsert_property`). See
// docs/design-notes/graph-native-authoring.md and kg-recipes/lc.ts.

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

  // The composite curriculum recipes are now GENERIC, graph-derived verbs in the
  // `kg-recipes` module (add_node / move_node / reposition / set_content),
  // available on every subject. An adapter no longer declares a `recipeProfile`,
  // `structuralAliases`, `availableRecipes`, or `lcNodeTemplate` — the recipes
  // read a created node's identity skeleton (labels, normalized type, ordinal
  // path) from the graph itself. See kg-recipes/lc.ts.

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

  // Raw envelope → normalized CurriculumModel; parse() owns all raw-schema
  // knowledge (via its GraphParseDescriptor). detect() is the bundle-mode schema
  // guard set_context runs before activating — now a generic envelope check
  // (adapters/engine.ts::detectEnvelope); the subject was already chosen by the
  // grade/subject key, so no subject-specific signal is needed.
  detect(raw: unknown): boolean;
  parse(raw: unknown): CurriculumModel;

  // The active CurriculumModel (memoized; published slot in firestore mode, the
  // on-disk bundle in dev). Generic — it carries the echoed `rawGraph`, so the
  // tool layer can read raw LC nodes/edges without a subject projection. This is
  // now the ONLY read surface the adapter exposes: the cooked per-unit projection
  // (slice/listUnits/progression/…) and buildGenerationContext were removed once
  // generation moved to the generic graph readers (list_courses / get_course /
  // get_standards) — see docs/design-notes/logic-in-the-graph.md.
  model(): CurriculumModel;

  // Optional, capability-gated at the tool boundary.
  suggestFreshDomain?(): Promise<unknown>;
  domainUsage?(): Promise<unknown>;
}
