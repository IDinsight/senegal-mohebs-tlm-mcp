/*
 * Layer: core (leaf)
 *
 * Static configuration read once from the environment: where local sources live,
 * the canonical per-subject source filenames, Firebase credentials, and the
 * config-derived DOCX_MIME/basePrefix helpers. Imports nothing from this project,
 * so every other module can import it freely without risk of a cycle. (Pure
 * string helpers like slug/noAccents live in utils/.)
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (p: string) => resolve(PKG_ROOT, p);

export const CONFIG = {
  // Sources root (override with TLM_SOURCES_DIR). Under it, one folder per grade,
  // then per subject, resolved at runtime for the active context (context/state.ts).
  // The per-subject filenames below are fixed conventions — the same in every
  // subject folder.
  sourcesDir: env.TLM_SOURCES_DIR ? resolve(env.TLM_SOURCES_DIR) : fromRoot("sources"),
  kgFile: "knowledge_graph.json",
  terminologyFile: "terminology.json",
  exampleDomainsFile: "example_domains.json",
  // Firebase Storage (shared source of truth for documents + history).
  serviceAccountKeyPath: env.SERVICE_ACCOUNT_KEY_PATH ?? "",
  // Alternative to the key path: the key's JSON content directly (for hosts
  // where mounting a file is impractical). Path wins if both are set.
  serviceAccountKeyJson: env.SERVICE_ACCOUNT_KEY_JSON ?? "",
  firebaseBucket: env.FIREBASE_STORAGE_BUCKET ?? "",
  bucketPrefix: (env.TLM_BUCKET_PREFIX ?? "").replace(/\/+$/, ""), // optional, no trailing slash
  // Optional startup defaults for the active teaching context.
  defaultWorkspace: (env.TLM_WORKSPACE ?? "").trim(),
  defaultGrade: (env.TLM_GRADE ?? "").trim(),
  defaultSubject: (env.TLM_SUBJECT ?? "").trim(),
};

// The single tenant every graph belonged to before workspaces existed, and the
// default for the 2-arg kgNamespace() convenience + a source folder that has no
// workspace segment yet. Production paths always pass a workspace explicitly;
// this only backstops single-tenant/legacy call sites (tests, un-migrated
// sources). See docs/design-notes/workspaces.md.
export const DEFAULT_WORKSPACE = "senegal";

// Root of trust for super admins: comma-separated JWT `sub`s or emails. Env-only
// in v1 (not stored, not grantable at runtime) so the first super admin exists
// before any workspace or membership does — see docs/design-notes/workspaces.md.
export function superAdmins(): string[] {
  return (process.env.TLM_SUPER_ADMINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Where curriculum + KG reads pull from. "bundle" keeps the legacy behavior
// (readFileSync from sources/); "firestore" hydrates the normalized
// CurriculumModel from the generic node/edge store seeded by
// scripts/seed-kg-store.mjs. Reversible flag — flip either way without a
// rebuild. Unknown values collapse to "bundle".
//
// Resolved lazily (not memoised into CONFIG) so parity tests can toggle
// KG_SOURCE per case with `process.env.KG_SOURCE = ...` inside one run.
export type KgSource = "bundle" | "firestore";
export function kgSource(): KgSource {
  return (process.env.KG_SOURCE ?? "bundle").trim().toLowerCase() === "firestore" ? "firestore" : "bundle";
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Base object-key prefix from env. The active grade/subject scope is appended in
// context/state.ts so each context gets its own documents/ and history.json.
export const basePrefix = () => (CONFIG.bucketPrefix ? CONFIG.bucketPrefix + "/" : "");
