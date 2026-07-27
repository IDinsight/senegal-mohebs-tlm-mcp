// ── Module: context · state (leaf) ───────────────────────────────────────────
// The active teaching context — which grade + subject the server is working on.
// The choice selects (a) which local sources load and (b) which Firebase
// namespace documents and history live under. It must be set before any source-
// or bucket-dependent tool runs; when it isn't, requireContext() throws
// ContextNotSetError and the server prompts the user to choose one.
//
// This module is a dependency-light LEAF (imports only config + utils + the
// context/shared types). Many modules import it at init time, so it must not
// import profiles/* or storage/* back — the profile resolution + schema guard
// that need those live in the app-layer activate.ts (at the repo root).
import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG, basePrefix } from "../config.js";
import { slug } from "../utils/index.js";
import { type ActiveContext, ContextNotSetError } from "./shared.js";
import { sessionState } from "./session.js";

// The active context lives in the current session's state (per-session in HTTP
// mode, process-wide in stdio mode). Context-derived caches live in the same
// session's bag and are cleared wholesale on a context switch — this replaced
// the old onContextChange listener registry, which was process-global and
// therefore unsafe once multiple sessions share the process.

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Discover installed grade/subject sets by scanning sources/<grade>/<subject>/.
export function listAvailableContexts(): ActiveContext[] {
  const root = CONFIG.sourcesDir;
  if (!existsSync(root)) return [];
  const out: ActiveContext[] = [];
  for (const grade of readdirSync(root)) {
    const gradePath = resolve(root, grade);
    if (!isDir(gradePath)) continue;
    for (const subject of readdirSync(gradePath)) {
      if (isDir(resolve(gradePath, subject))) out.push({ grade, subject });
    }
  }
  return out.sort((a, b) => a.grade.localeCompare(b.grade) || a.subject.localeCompare(b.subject));
}

export function getActiveContext(): ActiveContext | null { return sessionState().active; }

export const subjectDir = (grade: string, subject: string) => resolve(CONFIG.sourcesDir, grade, subject);

// Low-level bind: slugify, validate against installed sources, set the active
// context, and drop the session's context-derived caches. Profile resolution
// and the schema guard live in activateContext() (root activate.ts) to avoid an
// import cycle; call that, not this, from tools and startup.
export function setActiveContext(grade: string, subject: string):
  | { ok: true; context: ActiveContext }
  | { ok: false; error: string; available: ActiveContext[] } {
  const g = slug(grade), s = slug(subject);
  const available = listAvailableContexts();
  const match = available.find((c) => c.grade === g && c.subject === s);
  if (!match) return { ok: false, error: `No sources installed for grade '${grade}' / subject '${subject}'.`, available };
  const st = sessionState();
  const changed = !st.active || st.active.grade !== match.grade || st.active.subject !== match.subject;
  st.active = match;
  if (changed) st.bag.clear();
  return { ok: true, context: match };
}

export function requireContext(): ActiveContext {
  const { active } = sessionState();
  if (!active) throw new ContextNotSetError(listAvailableContexts());
  return active;
}

// -- Context-scoped path + object-key helpers --------------------------------
export function activeSubjectDir(): string {
  const { grade, subject } = requireContext();
  return resolve(CONFIG.sourcesDir, grade, subject);
}
export const sourcePath = (name: string) => resolve(activeSubjectDir(), name);

const scope = () => { const { grade, subject } = requireContext(); return `${grade}/${subject}/`; };
export const docsPrefix = () => basePrefix() + scope() + "documents/";
export const historyKey = () => basePrefix() + scope() + "history.json";
export const docKey = (relPath: string) => docsPrefix() + relPath;
