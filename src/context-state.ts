// Active teaching context — which grade + subject the server is working on.
// The choice selects (a) which local sources load and (b) which Firebase
// namespace documents and history live under. It must be set before any
// source- or bucket-dependent tool runs; when it isn't, requireContext() throws
// ContextNotSetError and the server prompts the user to choose one.
import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG, basePrefix } from "./config.js";
import { slug } from "./utils/index.js";

export type ActiveContext = { grade: string; subject: string };

export class ContextNotSetError extends Error {
  readonly available: ActiveContext[];
  constructor(available: ActiveContext[]) {
    super("No active teaching context. Choose a grade and subject with set_context first.");
    this.name = "ContextNotSetError";
    this.available = available;
  }
}

let active: ActiveContext | null = null;

// Cache-invalidation hooks: modules that cache source- or bucket-derived data
// register here so switching context drops their stale state.
const resetListeners: Array<() => void> = [];
export function onContextChange(fn: () => void) { resetListeners.push(fn); }

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

export function getActiveContext(): ActiveContext | null { return active; }

export const subjectDir = (grade: string, subject: string) => resolve(CONFIG.sourcesDir, grade, subject);

// Low-level bind: slugify, validate against installed sources, set the active
// context, and fire cache-reset listeners. Profile resolution and the schema
// guard live in activateContext() (activate.ts) to avoid an import cycle; call
// that, not this, from tools and startup.
export function setActiveContext(grade: string, subject: string):
  | { ok: true; context: ActiveContext }
  | { ok: false; error: string; available: ActiveContext[] } {
  const g = slug(grade), s = slug(subject);
  const available = listAvailableContexts();
  const match = available.find((c) => c.grade === g && c.subject === s);
  if (!match) return { ok: false, error: `No sources installed for grade '${grade}' / subject '${subject}'.`, available };
  const changed = !active || active.grade !== match.grade || active.subject !== match.subject;
  active = match;
  if (changed) for (const fn of resetListeners) fn();
  return { ok: true, context: match };
}

export function requireContext(): ActiveContext {
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
