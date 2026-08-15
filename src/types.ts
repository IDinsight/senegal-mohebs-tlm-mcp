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

// A generated document's identity is the graph node it covers — its "scope node"
// (a Chapitre/Semaine/Lesson) — not a (unit, deliverable) coordinate. See
// docs/design-notes/graph-linked-documents.md. `id === nodeId`.
export type HistoryEntry = {
  id: string;                 // == nodeId (kept as `id` for the shared upsert/paging helpers)
  nodeId: string;             // the scope node this document covers
  relPath: string;
  md5: string;
  updated: string;
  source: "pipeline" | "parsed";
  recordedAt: string;
  content: DocumentContent;
  // TRANSITIONAL: the scope node's ordinal (chapter/week number), stamped at
  // record time from the graph. Kept only so CI-maths example-domain rotation
  // keeps working; it is removed when generation goes graph-native (step 4),
  // once rotation reads the ordinal straight from the node.
  unit?: number;
};

// Bumped to 3 for the node-keyed schema. A pre-node-keyed (v2) history can't be
// auto-mapped to node ids without the graph, so it is ignored on load and the
// bucket docs re-surface as untracked for re-linking (the "fresh reconcile"
// migration in graph-linked-documents.md).
export type HistoryFile = { version: 3; entries: HistoryEntry[] };

export type StoredObject = {
  relPath: string;
  md5: string | null;
  updated: string | null;
};

// A .docx object found in the documents bucket. Discovery no longer classifies
// (deliverables are gone from this path) — reconcile() diffs these against
// history BY relPath, and the curator links each untracked doc to its node.
export type DiscoveredDoc = {
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
  exampleDomainRotation: boolean;   // CI maths storybook variety; false for CE1 reading
};

// ─────────────────────────────────────────────────────────────────────────────
// SubjectAdapter — the single per-(grade, subject) object the rest of the
// server dispatches to. It is no longer hand-written per subject: a subject is a
// declarative `SubjectProfile` (adapters/profile.ts), and one generic factory
// (adapters/build.ts::buildAdapterFromProfile) synthesizes this object from it.
// The runtime shape below is what consumers see; its fields are DERIVED from the
// profile's data (see docs/design-notes/authorable-catalog.md, phase 2).
// Deliberately BEHAVIOR ONLY: no schema, no LC property/edge/cardinality
// declarations, no integrity rules. Write-safety rules live in the write tools.
//
// Common core:
//   - raw-schema knowledge (detect + parse) — the only place that touches raw
//     graph JSON. `parse` is `parseGraph` bound to the profile's descriptor;
//     the storage round-trip is handled generically by curriculum/store-bridge.ts;
//   - `model()` — the parsed CurriculumModel (memoized). The cooked per-unit
//     projection (slice/listUnits/…) and buildGenerationContext were removed once
//     generation moved to the generic graph readers (walk_graph / get_standards);
//   - deliverables, capabilities, and the optional coverage hook, all
//     synthesized from the profile.
//
// Optional subject-specific functions (declared on the interface but not every
// adapter implements them). Present only when the corresponding capability is
// enabled; gated at the tool boundary in src/server/*.
// ─────────────────────────────────────────────────────────────────────────────

// Curriculum edits are the GENERIC verbs (add_node / move_node / reposition /
// set_content) that live in the `kg-recipes` module and derive a created node's
// identity from the graph itself. There is no per-subject `RecipeProfile` /
// `StructuralAliases` / `LcNodeTemplate`, and no wording-alias surface — a node's
// text is edited through those verbs. See docs/design-notes/graph-native-authoring.md.

export interface SubjectAdapter {
  readonly grade: string;
  readonly subject: string;
  readonly id: string;                          // stable adapter id, e.g. "ci-maths/nodes-relationships-v1"
  readonly deliverables: DeliverableSpec[];
  readonly capabilities: Capabilities;

  // The composite curriculum recipes are now GENERIC, graph-derived verbs in the
  // `kg-recipes` module (add_node / move_node / reposition / set_content),
  // available on every subject. An adapter no longer declares a `recipeProfile`,
  // `structuralAliases`, `availableRecipes`, or `lcNodeTemplate` — the recipes
  // read a created node's identity skeleton (labels, normalized type, ordinal
  // path) from the graph itself. See kg-recipes/lc.ts.
  //
  // Coverage/completeness is no longer an adapter hook: the coded rules were
  // retired (phase 2c) in favour of the subject's coverage EXPECTATIONS authored
  // as prose in the graph guide, reviewed on demand by `review_draft`.

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
  // generation moved to the generic graph readers (walk_graph /
  // get_standards) — see docs/design-notes/logic-in-the-graph.md.
  model(): CurriculumModel;

  // Optional, capability-gated at the tool boundary.
  suggestFreshDomain?(): Promise<unknown>;
  domainUsage?(): Promise<unknown>;
}
