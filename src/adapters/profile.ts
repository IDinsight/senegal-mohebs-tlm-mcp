/*
 * Module: adapters · subject profile (schema)
 *
 * A `SubjectProfile` is the DATA that describes a subject to the generic adapter
 * builder (build.ts). It replaces the hand-written per-subject behavior modules:
 * everything those modules used to express as code — which LC label/role maps to
 * which read kind, the deliverables, the editable wording paths, the coverage
 * rules, the parse-time prune — is expressed here as a validated literal.
 *
 * The three function-valued bits the old adapters carried are declared as data
 * and synthesized generically by the builder:
 *   - a deliverable's `classify(filename)`  → a `match` spec (default | substring);
 *   - a subject's `coverageWarnings(graph)`  → a list of named coverage rules;
 *   - the parse descriptor's `postParse`     → a named prune strategy.
 *
 * The Zod schema is the single source of truth; the exported types are inferred
 * from it, so schema and type can never drift. `validateProfile` is the guard —
 * a malformed profile fails here (at load today; at authoring time once profiles
 * move to the store, per docs/design-notes/authorable-catalog.md phase 2b).
 */
import { z } from "zod";

// ── Deliverable classification (was DeliverableSpec.classify) ────────────────
// A file is recognised as a deliverable by matching its filename. Two shapes:
//   - "default": the fallback — matches iff no OTHER deliverable's specific
//     match does (reproduces the old `manual = !isLessons` complement without
//     naming the sibling); a subject with one deliverable uses this.
//   - { filenameContainsAny }: accent/case-insensitive substring match (e.g. the
//     maths teacher guide, whose filenames contain "fiche(s) de leçon").
const deliverableMatchSchema = z.union([
  z.literal("default"),
  z.object({ filenameContainsAny: z.array(z.string()).min(1) }).strict(),
]);

const deliverableSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    scopeKind: z.string().min(1),          // which unit-kind ONE document covers
    match: deliverableMatchSchema,
    dependsOn: z.array(z.string()),        // deliverable keys required first ([] = standalone)
    promptFile: z.string().nullable(),     // generation prompt basename, or null
    pathHint: z.string().optional(),
  })
  .strict();

// ── Parse descriptor (the GraphParseDescriptor, minus the postParse closure) ──
// `prune` names a generic strategy (prunes.ts) that becomes the descriptor's
// postParse. Everything else is the descriptor verbatim.
const pruneSchema = z
  .object({
    strategy: z.literal("content-reachable-from-roots"),
    rootKinds: z.array(z.string()).min(1),
  })
  .strict();

const edgeSchema = z.union([z.string(), z.array(z.string())]);

const parseSchema = z
  .object({
    // A node's kind comes from its own canonical LC fields (groupName for
    // groupings, statementType for standards, label for content) — no per-subject
    // kind table, so nothing to declare here beyond the ordinal + edge wiring.
    numberFrom: z.enum(["order", "position", "description"]).optional(),
    containerEdge: edgeSchema.optional(),
    supportEdge: edgeSchema.optional(),
    progressionEdge: z.string().optional(),
    dependencyEdge: z.string().optional(),
    prune: pruneSchema.optional(),
  })
  .strict();

// ── Coverage rules (was coverageWarnings(graph)) ─────────────────────────────
// A list of named generic rules, each parameterised by the kinds it applies to.
// The rule bodies live in curriculum/coverage.ts; the profile only selects and
// parameterises them. `noun` lets a subject keep its own word for an assessment
// (maths says "bilan") while the rule stays subject-agnostic.
const coverageRuleSchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("empty-container"), kinds: z.array(z.string()).min(1) }).strict(),
  z.object({ rule: z.literal("multi-parent"), childKinds: z.array(z.string()).optional() }).strict(),
  z
    .object({
      rule: z.literal("exactly-one-assessment-child"),
      parentKind: z.string(),
      childKind: z.string(),
      containment: z.string().optional(),
      noun: z.string().optional(),
    })
    .strict(),
  z
    .object({
      rule: z.literal("single-content-parent"),
      childKind: z.string(),
      parentKind: z.string(),
      containment: z.string().optional(),
    })
    .strict(),
]);

const capabilitiesSchema = z
  .object({
    exampleDomainRotation: z.boolean(),
  })
  .strict();

export const subjectProfileSchema = z
  .object({
    id: z.string().min(1),               // stable adapter id, e.g. "ci-maths/nodes-relationships-v1"
    capabilities: capabilitiesSchema,
    parse: parseSchema,
    deliverables: z.array(deliverableSchema),
    coverage: z.array(coverageRuleSchema).optional(),
  })
  .strict();

export type SubjectProfile = z.infer<typeof subjectProfileSchema>;
export type DeliverableProfile = z.infer<typeof deliverableSchema>;
export type DeliverableMatch = z.infer<typeof deliverableMatchSchema>;
export type ParseProfile = z.infer<typeof parseSchema>;
export type PruneSpec = z.infer<typeof pruneSchema>;
export type CoverageRuleSpec = z.infer<typeof coverageRuleSchema>;

// Validate a profile literal (the machine `core`). Throws a readable error
// naming the offending path so a bad profile fails loudly at the boundary,
// never as a silent mis-parse deep in a read.
export function validateProfile(raw: unknown, context = "subject profile"): SubjectProfile {
  const result = subjectProfileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid ${context}: ${issues}`);
  }
  return result.data;
}

// ── The layered profile record (phase 2c) ────────────────────────────────────
// The AUTHORED/STORED profile is a two-field record: a machine-readable `core`
// (the SubjectProfile above, consumed by the deterministic parser/classifier)
// plus an optional `guide` — authored markdown the AUTHORING/GENERATING LLM
// reads to interpret and modify the graph. The two never mix: reads consume only
// `core`; the guide never sits on the read hot path. See
// docs/design-notes/authorable-catalog.md phase 2c.
export type ProfileRecord = { core: SubjectProfile; guide?: string };

// The guide is free text, capped so the config cell (two slots' worth of
// core + guide, on the pointer doc) stays well under Firestore's 1MB doc limit.
export const MAX_GUIDE_CHARS = 100_000;

// Accept BOTH the new { core, guide } record AND a legacy FLAT SubjectProfile
// (what phase 2b seeded before this split), so a not-yet-re-seeded namespace
// keeps resolving. A payload is new-shape iff it has a `core` key — no flat
// profile has one. Returns the still-unvalidated core + guide.
function splitRecord(raw: unknown): { core: unknown; guide: unknown } {
  if (raw !== null && typeof raw === "object" && "core" in (raw as Record<string, unknown>)) {
    const r = raw as Record<string, unknown>;
    return { core: r.core, guide: r.guide };
  }
  return { core: raw, guide: undefined }; // legacy flat profile
}

// Validate a stored/authored profile record. Validates `core` with the same Zod
// guard as validateProfile, and checks the optional `guide` is a string within
// the length cap. Throws a readable error at the boundary.
export function validateProfileRecord(raw: unknown, context = "subject profile"): ProfileRecord {
  const { core, guide } = splitRecord(raw);
  const validCore = validateProfile(core, context);
  if (guide === undefined) return { core: validCore };
  if (typeof guide !== "string") throw new Error(`Invalid ${context}: guide must be a markdown string.`);
  if (guide.length > MAX_GUIDE_CHARS) throw new Error(`Invalid ${context}: guide is ${guide.length} chars, over the ${MAX_GUIDE_CHARS}-char limit.`);
  return { core: validCore, guide };
}
