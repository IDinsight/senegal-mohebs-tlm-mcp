/*
 * Module: server · tool group: subject-profile config
 * (get_profile / edit_profile / get_graph_guide)
 *
 * The subject PROFILE is a two-field record (phase 2c): a machine `core` (the
 * declarative config that drives parsing / deliverables / coverage) plus an
 * optional authored `guide` — markdown the AUTHORING/GENERATING LLM reads to
 * interpret and modify the graph. Reads consume only the core; the guide never
 * sits on the read hot path. The record lives in the store's config cell beside
 * the graph, rides the shared draft/publish loop, and is edited here through the
 * same two-phase envelope as a graph edit. The Zod guard that used to run only at
 * process load now runs at AUTHORING time: edit_profile injects it (plus a light
 * referential check) into the store's config-flow, so a malformed core is refused
 * at dry-run instead of mis-parsing a whole workspace at runtime.
 *
 * `get_graph_guide` is the LLM-facing read — just the markdown, like get_prompt /
 * get_terminology surface per-subject text. See docs/design-notes/authorable-catalog.md.
 *
 * In bundle mode (dev) there is no store: reads return the in-repo record and
 * edit_profile is unavailable (the literal is the source of truth there).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter, getRegisteredProfile, getRegisteredGuide, validateProfileRecord, type SubjectProfile } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { currentActor } from "../actor.js";
import { authorize } from "../authz.js";
import { kgSource } from "../config.js";
import { kgNamespace, getKgStore, editProfileWithConfirm, type StoredConfig } from "../kg-store/index.js";

// Every kind a profile core's rules key on — the referential-check targets. A
// coverage/deliverable rule naming a kind no node carries is valid Zod but
// matches nothing, so it earns a (non-blocking) warning.
function referencedKinds(core: SubjectProfile): string[] {
  const kinds = new Set<string>();
  for (const d of core.deliverables) kinds.add(d.scopeKind);
  for (const rule of core.coverage ?? []) {
    if (rule.rule === "empty-container") rule.kinds.forEach((k) => kinds.add(k));
    else if (rule.rule === "multi-parent") (rule.childKinds ?? []).forEach((k) => kinds.add(k));
    else { kinds.add(rule.parentKind); kinds.add(rule.childKind); }
  }
  return [...kinds];
}

// The authored `guide` markdown from a stored config value, whatever its shape:
// the new { core, guide } record carries it; a legacy flat profile (pre-2c seed)
// has none. Returns undefined when absent.
function guideOf(raw: unknown): string | undefined {
  if (raw !== null && typeof raw === "object" && "core" in (raw as Record<string, unknown>)) {
    const g = (raw as Record<string, unknown>).guide;
    return typeof g === "string" ? g : undefined;
  }
  return undefined;
}

// The validator injected into editProfileWithConfirm. `knownKinds` is captured
// from the current graph so the referential check runs without the store layer
// (which stays subject-agnostic) knowing what a "kind" is. validateProfileRecord
// blocks a malformed core or an over-long guide; the referential mismatches warn.
function makeValidator(namespace: string, knownKinds: Set<string>) {
  return (proposed: StoredConfig): { errors: string[]; warnings: string[] } => {
    let core: SubjectProfile;
    try {
      ({ core } = validateProfileRecord(proposed, `profile for ${namespace}`));
    } catch (e) {
      return { errors: [(e as Error).message], warnings: [] };
    }
    const warnings = referencedKinds(core)
      .filter((k) => !knownKinds.has(k))
      .map((k) => `profile references kind '${k}', but no node in the current graph has that kind — a coverage or deliverable rule keyed on it will match nothing.`);
    return { errors: [], warnings };
  };
}

// The in-repo record for bundle/dev mode: the core literal + its authored guide.
function inRepoRecord(grade: string, subject: string): StoredConfig {
  const core = getRegisteredProfile(grade, subject);
  const guide = getRegisteredGuide(grade, subject);
  return guide !== undefined ? { core, guide } : { core };
}

// ── Tool cores (exported for tests, wrapped by the tools below) ───────────────
// Each returns the plain response object; the tool wraps it in asJson + guarded.
// The active adapter / workspace / actor come from session state, so callers
// (and tests) run these inside an activated context.

export async function readProfile(slot?: "published" | "draft"): Promise<Record<string, unknown>> {
  const adapter = getActiveAdapter();
  const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

  if (kgSource() !== "firestore") {
    // Dev/bundle: the in-repo record is the profile; there is no draft.
    return { source: "in-repo-literal", slot: "published", namespace, profile: inRepoRecord(adapter.grade, adapter.subject) };
  }

  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer) return { error: `No seed found for namespace '${namespace}'. Run the seed first.` };

  if (slot === "draft") {
    // Reading the unpublished draft is the same trust tier as diff_draft.
    const authz = authorize(currentActor(), "readDraft", namespace);
    if (!authz.ok) return { error: `Reading the draft profile is restricted: ${authz.reason}` };
    if (!pointer.draftSlot) return { hasDraft: false, message: "No draft is open, so there is no staged profile to show. Reading the published profile instead is available via slot:'published'." };
    return { source: "store", slot: "draft", namespace, profile: await store.readConfig(namespace, pointer.draftSlot) };
  }

  return { source: "store", slot: "published", namespace, profile: await store.readConfig(namespace, pointer.publishedSlot) };
}

export async function readGraphGuide(slot?: "published" | "draft"): Promise<Record<string, unknown>> {
  const adapter = getActiveAdapter();
  const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

  if (kgSource() !== "firestore") {
    const guide = getRegisteredGuide(adapter.grade, adapter.subject);
    return { source: "in-repo-literal", namespace, hasGuide: guide !== undefined, guide: guide ?? null };
  }

  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer) return { error: `No seed found for namespace '${namespace}'. Run the seed first.` };

  let readSlot = pointer.publishedSlot;
  if (slot === "draft") {
    const authz = authorize(currentActor(), "readDraft", namespace);
    if (!authz.ok) return { error: `Reading the draft guide is restricted: ${authz.reason}` };
    if (!pointer.draftSlot) return { hasDraft: false, message: "No draft is open; read the published guide via slot:'published'." };
    readSlot = pointer.draftSlot;
  }
  const guide = guideOf(await store.readConfig(namespace, readSlot));
  return { source: "store", slot: slot ?? "published", namespace, hasGuide: guide !== undefined, guide: guide ?? null };
}

export async function runEditProfile(profile: Record<string, unknown>, confirm?: boolean, token?: string): Promise<unknown> {
  const adapter = getActiveAdapter();
  const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

  if (kgSource() !== "firestore") {
    return { error: "edit_profile is only available in firestore mode. In bundle/dev mode the subject profile is the in-repo record — edit src/adapters/profiles/ and re-seed." };
  }

  // Capture the current graph's kinds for the referential check. Use the draft
  // slot when one is open (that's the surface the edit lands on), else published.
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  const slot = pointer?.draftSlot ?? pointer?.publishedSlot;
  const nodes = slot ? await store.listNodes(namespace, slot) : [];
  const knownKinds = new Set(nodes.map((n) => n.type));

  return editProfileWithConfirm(namespace, profile, {
    confirm, token,
    validate: makeValidator(namespace, knownKinds),
  });
}

export function registerProfileTools(server: McpServer) {
  server.registerTool(
    "get_profile",
    {
      title: "Read the subject profile",
      description:
        "Read the active grade/subject's SUBJECT PROFILE record — { core, guide }: the machine `core` (config that drives parsing, deliverables, coverage) plus the authored `guide` markdown (phase 2c). Read-only. In firestore mode it comes from the store's config cell (the live source of truth, editable via edit_profile); pass slot:'draft' to see a staged, unpublished edit (curator/approver only). In bundle/dev mode it is the in-repo record. Use this before edit_profile to get the exact record you'll edit and pass back. (To read just the guide markdown, use get_graph_guide.)",
      inputSchema: { slot: z.enum(["published", "draft"]).optional() },
    },
    guarded(async (a: { slot?: "published" | "draft" }) => asJson(await readProfile(a.slot))),
  );

  // The LLM-facing read: just the authored markdown guide for interpreting and
  // authoring this subject's graph. Call it before you walk or edit the graph.
  server.registerTool(
    "get_graph_guide",
    {
      title: "Read the subject's graph guide",
      description:
        "Read the authored GRAPH GUIDE for the active grade/subject — markdown that explains how this subject's knowledge graph is shaped (its ontology, vocabulary, the intended hierarchy) and the conventions for authoring it. Read this BEFORE you walk or modify the graph so your edits follow the subject's conventions. Read-only. Returns { hasGuide, guide }; guide is null when the subject ships none yet. In firestore mode it comes from the published config cell (slot:'draft' for a staged edit, curator/approver only).",
      inputSchema: { slot: z.enum(["published", "draft"]).optional() },
    },
    guarded(async (a: { slot?: "published" | "draft" }) => asJson(await readGraphGuide(a.slot))),
  );

  server.registerTool(
    "edit_profile",
    {
      title: "Edit the subject profile",
      description:
        "Replace the active grade/subject's SUBJECT PROFILE record with a new one — the two-phase, curator-gated way to change the machine `core` (parsing/deliverables/coverage) AND the authored `guide` markdown as DATA, with no redeploy (phase 2b/2c). Pass the WHOLE { core, guide } record (get_profile first, edit, pass it back); this replaces, it does not patch. A bare core (no guide) is accepted for back-compat. The core is validated against its schema and the guide length-checked AT THIS STEP — a malformed record is BLOCKED at dry-run (no token). A dry-run returns the before/after diff + any referential warnings (e.g. a rule naming a kind no node has) + a confirmationToken, changing nothing; confirm STAGES it onto the draft (a profile edit and curriculum edits share one draft). Nothing reaches generation until you publish_draft. firestore mode only — in bundle/dev mode the profile is the in-repo record, edited in the repo.",
      inputSchema: {
        profile: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { profile: Record<string, unknown>; confirm?: boolean; confirmationToken?: string }) =>
      asJson(await runEditProfile(a.profile, a.confirm, a.confirmationToken))),
  );
}
