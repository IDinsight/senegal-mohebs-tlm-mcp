// ─────────────────────────────────────────────────────────────────────────────
// Deliverables & history
// ─────────────────────────────────────────────────────────────────────────────

// A deliverable key identifies one kind of document a subject produces
// (e.g. "manual", "lessons"). It is an open string drawn from the active
// SubjectProfile's deliverable list — NOT a fixed union — because the set of
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
  id: string;                 // `${scope}:${deliverableKey}` (maths: `${chapter}:manual`)
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
  text: string | null;                 // full statement text (osTexte / description)
  order: number | null;                // leconNum, or derived ordinal within siblings
  parentId: string | null;
  childIds: string[];                  // ordered children
  buildsTowards: string[];             // unit ids (empty if the subject has no progression)
  buildsFrom: string[];
  isAssessment: boolean;               // generalizes the maths "bilan"
  properties: Record<string, unknown>; // subject-specific passthrough
};

export interface CurriculumModel {
  roots: string[];                             // top-level unit ids
  byId: Map<string, CurriculumUnit>;
  unitsOfKind(kind: string): CurriculumUnit[];
  childrenOf(id: string): CurriculumUnit[];
}

// One module per graph *shape*. Owns all raw-schema knowledge. §5.2.
export interface CurriculumAdapter {
  readonly id: string;
  detect(raw: unknown): boolean;          // cheap structural check — is this my schema?
  parse(raw: unknown): CurriculumModel;   // envelope + taxonomy + hierarchy → normalized tree
}

// Tool-facing curriculum operations. Each subject renders its own JSON shapes
// from the normalized model (maths reproduces its historical chapter/lesson
// shapes exactly; other subjects present their own).
export interface SubjectCurriculum {
  detect(raw: unknown): boolean;                       // guard, delegates to the adapter
  listUnits(): unknown[];                              // list_chapters
  slice(scope: number | string): unknown | null;      // get_curriculum body (progression added by caller)
  progression(scope: number | string): unknown;       // cross-unit progression
  requiredCoverage(scope: number | string): unknown[]; // lessons/skills a deliverable must cover
  scopeValues(): Array<number | string>;               // every generation-unit scope (for coverage)
}

// ─────────────────────────────────────────────────────────────────────────────
// Deliverables & subject profile — axes 2–3. §5.3.
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
  exampleDomainRotation: boolean;   // maths storybook variety; false for reading
  characterConsistency: boolean;    // maths; false for reading
};

export interface SubjectProfile {
  grade: string;
  subject: string;
  curriculum: SubjectCurriculum;
  deliverables: DeliverableSpec[];
  capabilities: Capabilities;
  // Assemble the pre-generation context for one (scope, deliverable). Owned by
  // the profile because generation semantics (characters, domains, dependencies)
  // are subject-specific. §5 / axis 3.
  buildGenerationContext(scope: number | string, deliverableKey: DeliverableKey): Promise<unknown>;
}
