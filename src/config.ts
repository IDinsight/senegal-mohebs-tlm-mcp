// ── Layer: core (leaf) ───────────────────────────────────────────────────────
// Static configuration read once from the environment: where local sources live,
// the canonical per-subject source filenames, Firebase credentials, and small
// pure string helpers (slug, noAccents). Imports nothing from this project, so
// every other module can import it freely without risk of a cycle.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (p: string) => resolve(PKG_ROOT, p);

export const CONFIG = {
  // Sources root. Under it, one folder per grade, then per subject:
  //   sources/<grade>/<subject>/{knowledge_graph.json, terminology.json, PROMPT_*.md, …}
  // The active grade/subject is chosen at runtime (see context-state.ts); these
  // filenames are the canonical per-subject basenames resolved inside that folder.
  sourcesDir: env.TLM_SOURCES_DIR ? resolve(env.TLM_SOURCES_DIR) : fromRoot("sources"),
  kgFile: env.TLM_KG_FILE ?? "knowledge_graph.json",
  terminologyFile: env.TLM_TERMINOLOGY_FILE ?? "terminology.json",
  chapterPromptFile: env.TLM_CHAPTER_PROMPT ?? "PROMPT_generate_chapter.md",
  lessonsPromptFile: env.TLM_LESSONS_PROMPT ?? "PROMPT_generate_lessons.md",
  exampleDomainsFile: env.TLM_EXAMPLE_DOMAINS ?? "example_domains.json",
  // Firebase Storage (shared source of truth for documents + history).
  serviceAccountKeyPath: env.SERVICE_ACCOUNT_KEY_PATH ?? "",
  firebaseBucket: env.FIREBASE_STORAGE_BUCKET ?? "",
  bucketPrefix: (env.TLM_BUCKET_PREFIX ?? "").replace(/\/+$/, ""), // optional, no trailing slash
  // Optional startup defaults for the active teaching context.
  defaultGrade: (env.TLM_GRADE ?? "").trim(),
  defaultSubject: (env.TLM_SUBJECT ?? "").trim(),
};

export const noAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// Folder-safe identifier for a grade or subject (lowercase, ascii, dash-separated).
export const slug = (s: string) => noAccents(s).trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Base object-key prefix from env. The active grade/subject scope is appended in
// context-state.ts so each context gets its own documents/ and history.json.
export const basePrefix = () => (CONFIG.bucketPrefix ? CONFIG.bucketPrefix + "/" : "");
