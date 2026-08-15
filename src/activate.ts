/*
 * Layer: app
 *
 * Orchestrates switching the active teaching context: resolve the subject
 * adapter, run the schema guard for the KG source in use, then bind the
 * context and install the adapter. In KG_SOURCE=firestore mode this also
 * hydrates the parsed CurriculumModel from the store and pins it in the
 * session bag, so the (sync) adapter read methods can read from it without
 * needing to become async themselves.
 *
 * This is app-layer composition — it wires the leaf context module to the
 * adapters/ registry and the kg-store service — so it lives at the root
 * alongside index.ts rather than inside context/ (which stays a dependency-
 * light leaf).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG, kgSource } from "./config.js";
import { slug } from "./utils/index.js";
import { setActiveContext, listAvailableContexts, subjectDir, sessionState, type ActiveContext } from "./context/index.js";
import { resolveAdapter, buildAdapterFromStoredProfile, setActiveAdapter } from "./adapters/index.js";
import { getKgStore, kgNamespace } from "./kg-store/index.js";
import { toRawEnvelope, PRELOADED_MODEL_KEY } from "./curriculum/index.js";
import type { CurriculumModel } from "./types.js";

export type ActivateResult =
  | { ok: true; context: ActiveContext }
  | { ok: false; error: string; available: ActiveContext[] };

export async function activateContext(workspace: string, grade: string, subject: string): Promise<ActivateResult> {
  const w = slug(workspace), g = slug(grade), s = slug(subject);
  const available = listAvailableContexts();
  const match = available.find((c) => c.workspace === w && c.grade === g && c.subject === s);
  if (!match) return { ok: false, error: `No sources installed for workspace '${workspace}' / grade '${grade}' / subject '${subject}'.`, available };

  // The in-repo adapter is the registration check (a subject with no profile is
  // unsupported) AND the fallback for a firestore namespace seeded before the
  // config layer. In firestore mode it may be REPLACED below by an adapter built
  // from the namespace's stored profile.
  let adapter = resolveAdapter(match.grade, match.subject);
  if (!adapter) return { ok: false, error: `Sources exist for '${match.grade}/${match.subject}', but no subject adapter is registered for it. This grade/subject is not supported yet.`, available };

  // ── Schema guard ──────────────────────────────────────────────────────────
  // Bundle path: read the raw KG and let the adapter's detect() check it.
  // Firestore path: verify that this namespace has been seeded (a meta doc is
  // written LAST by scripts/seed-kg-store.mjs, so its presence proves the seed
  // finished). Falling through to bundle in Firestore mode would silently
  // paper over an unseeded namespace, so we refuse instead.
  let preloadedModel: CurriculumModel | null = null;
  if (kgSource() === "firestore") {
    const ns = kgNamespace(match.workspace, match.grade, match.subject);
    // Resolve the *published* slot first, then read from it. Generation MUST
    // read published — draft-targeted reads live behind the internal lifecycle
    // API and are not exposed to tools in this step (see roadmap #15).
    let pointer;
    try {
      pointer = await getKgStore().readPointer(ns);
    } catch (e) {
      return { ok: false, error: `Could not reach the KG store for '${match.grade}/${match.subject}': ${(e as Error).message}`, available };
    }
    if (!pointer) return { ok: false, error: `KG_SOURCE=firestore but no seed found for namespace '${ns}'. Run: npm run seed:kg-store (see README).`, available };
    const publishedSlot = pointer.publishedSlot;
    const [meta, nodes, edges, storedConfig] = await Promise.all([
      getKgStore().readMeta(ns, publishedSlot),
      getKgStore().listNodes(ns, publishedSlot),
      getKgStore().listEdges(ns, publishedSlot),
      getKgStore().readConfig(ns, publishedSlot),
    ]);
    if (!meta) return { ok: false, error: `KG_SOURCE=firestore: pointer for '${ns}' says slot '${publishedSlot}' is published, but that slot has no meta. Re-run the seed.`, available };
    // Phase 2b: the SUBJECT PROFILE is authored data. When the published slot
    // carries a profile cell, build the adapter from it (the store is the source
    // of truth for a live server), so a published profile edit takes effect with
    // no redeploy. A namespace seeded before the config layer has no cell yet —
    // fall back to the in-repo literal until it is re-seeded.
    if (storedConfig) {
      try {
        adapter = buildAdapterFromStoredProfile(match.grade, match.subject, storedConfig);
      } catch (e) {
        return { ok: false, error: `The stored subject profile for '${ns}' is invalid and would mis-parse: ${(e as Error).message}. Fix it via edit_profile or re-run the seed.`, available };
      }
    }
    // The store holds the full raw graph; reconstruct the LC envelope and run
    // the SAME parser bundle-mode uses, so the spine model is identical
    // (guarded by parity:kg-store). Non-spine nodes are dropped by parse here,
    // exactly as for a bundle read.
    preloadedModel = adapter.parse(toRawEnvelope({ nodes, edges }));
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(subjectDir(match.workspace, match.grade, match.subject), CONFIG.kgFile), "utf8"));
    } catch (e) {
      return { ok: false, error: `Could not read the knowledge graph for '${match.grade}/${match.subject}': ${(e as Error).message}`, available };
    }
    if (!adapter.detect(raw)) {
      return { ok: false, error: `The knowledge graph for '${match.grade}/${match.subject}' does not match the schema the '${match.subject}' adapter understands. Refusing to load it, since it would mis-parse. See docs/design-notes/multi-subject-architecture.md.`, available };
    }
  }

  const bound = setActiveContext(match.workspace, match.grade, match.subject); // clears the session bag
  if (!bound.ok) return bound;
  // The bag is now clean — install the preloaded model AFTER binding so the
  // just-run bag.clear() doesn't wipe it. Bundle-mode leaves the bag untouched.
  if (preloadedModel) sessionState().bag.set(PRELOADED_MODEL_KEY, preloadedModel);
  setActiveAdapter(adapter);
  return { ok: true, context: bound.context };
}
