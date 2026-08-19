/*
 * Layer: app
 *
 * Orchestrates switching the active teaching context: resolve the subject
 * adapter, run the schema guard for the KG source in use, then bind the
 * context and install the adapter. It hydrates the parsed CurriculumModel from
 * the store (the only KG source) and pins it in the session bag, so the (sync)
 * adapter read methods can read from it without needing to become async
 * themselves.
 *
 * This is app-layer composition — it wires the leaf context module to the
 * adapters/ registry and the kg-store service — so it lives at the root
 * alongside index.ts rather than inside context/ (which stays a dependency-
 * light leaf).
 */
import { slug, timed, timedSync } from "./utils/index.js";
import { setActiveContext, setAvailableContexts, listAvailableContexts, getActiveContext, sessionState, type ActiveContext } from "./context/index.js";
import { resolveAdapter, buildAdapterFromStoredProfile, setActiveAdapter } from "./adapters/index.js";
import { getKgStore, kgNamespace, parseNamespace } from "./kg-store/index.js";
import { toRawEnvelope, PRELOADED_MODEL_KEY, PRELOADED_SLOT_KEY } from "./curriculum/index.js";
import type { CurriculumModel } from "./types.js";

export type ActivateResult =
  | { ok: true; context: ActiveContext }
  | { ok: false; error: string; available: ActiveContext[] };

// Populate the installed-context list from the KG store: every namespace with a
// pointer, parsed back into a teaching context (catalog partitions filtered
// out). The store is the source of truth for which graphs exist, so this
// replaces the on-disk sources/ scan. Best-effort: on a store error we leave the
// list unset so listAvailableContexts falls back to the disk scan. Called at
// startup (firestore mode) and after an import adds a namespace.
export async function refreshAvailableContexts(): Promise<void> {
  const namespaces = await getKgStore().listNamespaces();
  const contexts = namespaces
    .map(parseNamespace)
    .filter((c): c is ActiveContext => c !== null)
    .sort((a, b) => a.workspace.localeCompare(b.workspace) || a.grade.localeCompare(b.grade) || a.subject.localeCompare(b.subject));
  setAvailableContexts(contexts);
}

export async function activateContext(workspace: string, grade: string, subject: string): Promise<ActivateResult> {
  const w = slug(workspace), g = slug(grade), s = slug(subject);
  const available = listAvailableContexts();
  const match = available.find((c) => c.workspace === w && c.grade === g && c.subject === s);
  if (!match) return { ok: false, error: `No graph found in the store for workspace '${workspace}' / grade '${grade}' / subject '${subject}'. Import it first.`, available };

  // The in-repo adapter is the registration check (a subject with no profile is
  // unsupported); below it is REPLACED by an adapter built from the namespace's
  // stored profile cell (the store is the source of truth for a live server).
  let adapter = resolveAdapter(match.workspace, match.grade, match.subject);
  if (!adapter) return { ok: false, error: `A graph exists for '${match.grade}/${match.subject}', but no subject adapter is registered for it. This grade/subject is not supported yet.`, available };

  // ── Hydrate from the store ──────────────────────────────────────────────────
  // Read the PUBLISHED slot (generation always reads published; draft reads go
  // through the lifecycle API). The pointer's presence is the "namespace exists"
  // check — discovery already listed it, but a concurrent delete could race, so
  // we still verify.
  const ns = kgNamespace(match.workspace, match.grade, match.subject);
  let pointer;
  try {
    pointer = await getKgStore().readPointer(ns);
  } catch (e) {
    return { ok: false, error: `Could not reach the KG store for '${match.grade}/${match.subject}': ${(e as Error).message}`, available };
  }
  if (!pointer) return { ok: false, error: `No graph in the store for namespace '${ns}'. Import it first.`, available };
  const publishedSlot = pointer.publishedSlot;
  const [meta, nodes, edges, storedConfig] = await timed("activate.readGraph", () => Promise.all([
    getKgStore().readMeta(ns, publishedSlot),
    getKgStore().listNodes(ns, publishedSlot),
    getKgStore().listEdges(ns, publishedSlot),
    getKgStore().readConfig(ns, publishedSlot),
  ]));
  if (!meta) return { ok: false, error: `The pointer for '${ns}' says slot '${publishedSlot}' is published, but that slot has no meta — the graph is corrupt. Re-import it.`, available };
  // The SUBJECT PROFILE is authored data on the published slot. Build the adapter
  // from that stored profile so a published profile edit takes effect with no
  // redeploy; a namespace with no cell falls back to the in-repo literal.
  if (storedConfig) {
    try {
      adapter = buildAdapterFromStoredProfile(match.workspace, match.grade, match.subject, storedConfig);
    } catch (e) {
      return { ok: false, error: `The stored subject profile for '${ns}' is invalid and would mis-parse: ${(e as Error).message}. Fix it via edit_profile or re-import.`, available };
    }
  }
  // The store holds the full raw graph; reconstruct the LC envelope and parse it
  // into the spine model (non-spine nodes are dropped by parse).
  const preloadedModel: CurriculumModel = timedSync("activate.parse", () => adapter.parse(toRawEnvelope({ nodes, edges })));

  const bound = setActiveContext(match.workspace, match.grade, match.subject); // clears the session bag
  if (!bound.ok) return bound;
  // The bag is now clean — install the preloaded model AFTER binding so the
  // just-run bag.clear() doesn't wipe it. Stamp the slot we hydrated from next
  // to it so the read tools can report the true origin of published reads.
  sessionState().bag.set(PRELOADED_MODEL_KEY, preloadedModel);
  sessionState().bag.set(PRELOADED_SLOT_KEY, publishedSlot);
  setActiveAdapter(adapter);
  return { ok: true, context: bound.context };
}

// Re-hydrate the ACTIVE context's published read model from the store, replacing
// the snapshot pinned at set_context. The published model is a session-scoped
// snapshot (parsed once, read synchronously); publish_draft flips the published
// pointer in the store WITHOUT touching that snapshot, so in-session published
// reads (walk_graph / namespace_stats / generation) would otherwise keep serving
// the pre-publish slot. Calling this at the end of a successful publish re-reads
// the now-current published slot (and rebuilds the adapter from the freshly
// published profile cell, so a published profile edit also lands in-session).
// A no-op with an ok:false result when there is no active context to refresh.
export async function refreshActiveContext(): Promise<ActivateResult> {
  const ctx = getActiveContext();
  if (!ctx) return { ok: false, error: "No active context to refresh.", available: listAvailableContexts() };
  return activateContext(ctx.workspace, ctx.grade, ctx.subject);
}
