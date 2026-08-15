/*
 * Module: context · state (leaf)
 *
 * The active teaching context — which grade + subject the server is working on.
 * The choice selects (a) which local sources load and (b) which Firebase
 * namespace documents and history live under. It must be set before any source-
 * or bucket-dependent tool runs; when it isn't, requireContext() throws
 * ContextNotSetError and the server prompts the user to choose one.
 *
 * This module is a dependency-light LEAF (imports only config + utils + the
 * context/shared types). Many modules import it at init time, so it must not
 * import adapters/* or storage/* back — the adapter resolution + schema guard
 * that need those live in the app-layer activate.ts (at the repo root).
 */
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

// Installed contexts, discovered from the KG store (the source of truth for
// WHICH graphs exist). This module is a dependency-light leaf that must not
// import kg-store — so the app layer reads the store's namespaces and PUSHES the
// parsed list here via setAvailableContexts (activate.ts::refreshAvailableContexts,
// called at startup and after an import). Until it does, the list is empty.
let storeContexts: ActiveContext[] = [];

// Install (or reset, with null) the store-derived context list.
export function setAvailableContexts(contexts: ActiveContext[] | null): void { storeContexts = contexts ?? []; }

// The installed contexts — whatever the store snapshot last reported.
export function listAvailableContexts(): ActiveContext[] { return storeContexts; }

export function getActiveContext(): ActiveContext | null { return sessionState().active; }

// Low-level bind: slugify, validate against installed sources, set the active
// context, and drop the session's context-derived caches. Adapter resolution
// and the schema guard live in activateContext() (root activate.ts) to avoid an
// import cycle; call that, not this, from tools and startup.
export function setActiveContext(workspace: string, grade: string, subject: string):
  | { ok: true; context: ActiveContext }
  | { ok: false; error: string; available: ActiveContext[] } {
  const w = slug(workspace), g = slug(grade), s = slug(subject);
  const available = listAvailableContexts();
  const match = available.find((c) => c.workspace === w && c.grade === g && c.subject === s);
  if (!match) return { ok: false, error: `No graph found in the store for workspace '${workspace}' / grade '${grade}' / subject '${subject}'. Import it first.`, available };
  const st = sessionState();
  const changed = !st.active || st.active.workspace !== match.workspace || st.active.grade !== match.grade || st.active.subject !== match.subject;
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
// The active subject's on-disk ASSET directory (terminology glossary, legacy
// prompt files). The KG is not here — it lives only in the store.
export function activeAssetDir(): string {
  const { workspace, grade, subject } = requireContext();
  return resolve(CONFIG.assetsDir, workspace, grade, subject);
}
export const assetPath = (name: string) => resolve(activeAssetDir(), name);

// The active workspace — the tenant segment production namespace/storage keys
// hang off. Throws (via requireContext) if no context is set.
export const activeWorkspace = (): string => requireContext().workspace;

const scope = () => { const { workspace, grade, subject } = requireContext(); return `${workspace}/${grade}/${subject}/`; };
export const docsPrefix = () => basePrefix() + scope() + "documents/";
export const historyKey = () => basePrefix() + scope() + "history.json";
export const docKey = (relPath: string) => docsPrefix() + relPath;

// Preview objects live under a SIBLING prefix to documents/ (never inside it),
// so a preview .docx is observably non-canonical: reconcile/discoverDocuments
// only scan docsPrefix(), so nothing under previews/ can ever reach the tracked
// document history. Used only by the preview-generation output path. Kept
// separate from docKey deliberately — a preview must not share the canonical
// documents keyspace.
export const previewsPrefix = () => basePrefix() + scope() + "previews/";
export const previewKey = (relPath: string) => previewsPrefix() + relPath;
