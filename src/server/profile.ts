/*
 * Module: server · tool group: subject-profile config (get_profile / edit_profile)
 *
 * The subject PROFILE — the declarative record that configures parsing,
 * deliverables, and coverage for a (grade, subject) — is authored data (phase
 * 2b). It lives in the store's config cell beside the graph, rides the shared
 * draft/publish loop, and is edited here through the same two-phase envelope as
 * a graph edit. The Zod guard that used to run only at process load now runs at
 * AUTHORING time: edit_profile injects it (plus a light referential check) into
 * the store's config-flow, so a malformed profile is refused at dry-run instead
 * of mis-parsing a whole workspace at runtime. See docs/design-notes/authorable-catalog.md.
 *
 * In bundle mode (dev) there is no store: get_profile returns the in-repo
 * literal and edit_profile is unavailable (the literal is the source of truth
 * there, edited in the repo).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter, getRegisteredProfile, validateProfile, type SubjectProfile } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { currentActor } from "../actor.js";
import { authorize } from "../authz.js";
import { kgSource } from "../config.js";
import { kgNamespace, getKgStore, editProfileWithConfirm, type StoredConfig } from "../kg-store/index.js";

// Every kind a profile's rules key on — the referential-check targets. A
// coverage/deliverable rule naming a kind no node carries is valid Zod but
// matches nothing, so it earns a (non-blocking) warning.
function referencedKinds(profile: SubjectProfile): string[] {
  const kinds = new Set<string>();
  for (const d of profile.deliverables) kinds.add(d.scopeKind);
  for (const rule of profile.coverage ?? []) {
    if (rule.rule === "empty-container") rule.kinds.forEach((k) => kinds.add(k));
    else if (rule.rule === "multi-parent") (rule.childKinds ?? []).forEach((k) => kinds.add(k));
    else { kinds.add(rule.parentKind); kinds.add(rule.childKind); }
  }
  return [...kinds];
}

// The validator injected into editProfileWithConfirm. `knownKinds` is captured
// from the current graph so the referential check runs without the store layer
// (which stays subject-agnostic) knowing what a "kind" is. Errors block; the
// referential mismatches only warn.
function makeValidator(namespace: string, knownKinds: Set<string>) {
  return (proposed: StoredConfig): { errors: string[]; warnings: string[] } => {
    let parsed: SubjectProfile;
    try {
      parsed = validateProfile(proposed, `profile for ${namespace}`);
    } catch (e) {
      return { errors: [(e as Error).message], warnings: [] };
    }
    const warnings = referencedKinds(parsed)
      .filter((k) => !knownKinds.has(k))
      .map((k) => `profile references kind '${k}', but no node in the current graph has that kind — a coverage or deliverable rule keyed on it will match nothing.`);
    return { errors: [], warnings };
  };
}

export function registerProfileTools(server: McpServer) {
  // ── get_profile ────────────────────────────────────────────────────────────
  server.registerTool(
    "get_profile",
    {
      title: "Read the subject profile",
      description:
        "Read the active grade/subject's SUBJECT PROFILE — the declarative config that drives parsing, deliverables, and coverage rules. Read-only. In firestore mode it comes from the store's config cell (the live source of truth, editable via edit_profile); pass slot:'draft' to see a staged, unpublished profile edit (curator/approver only). In bundle/dev mode it is the in-repo literal. Use this before edit_profile to see the current shape you're editing.",
      inputSchema: {
        slot: z.enum(["published", "draft"]).optional(),
      },
    },
    guarded(async (a: { slot?: "published" | "draft" }) => {
      const adapter = getActiveAdapter();
      const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

      if (kgSource() !== "firestore") {
        // Dev/bundle: the in-repo literal is the profile; there is no draft.
        return asJson({ source: "in-repo-literal", slot: "published", namespace, profile: getRegisteredProfile(adapter.grade, adapter.subject) });
      }

      const store = getKgStore();
      const pointer = await store.readPointer(namespace);
      if (!pointer) return asJson({ error: `No seed found for namespace '${namespace}'. Run the seed first.` });

      if (a.slot === "draft") {
        // Reading the unpublished draft is the same trust tier as diff_draft.
        const authz = authorize(currentActor(), "readDraft", namespace);
        if (!authz.ok) return asJson({ error: `Reading the draft profile is restricted: ${authz.reason}` });
        if (!pointer.draftSlot) return asJson({ hasDraft: false, message: "No draft is open, so there is no staged profile to show. Reading the published profile instead is available via slot:'published'." });
        return asJson({ source: "store", slot: "draft", namespace, profile: await store.readConfig(namespace, pointer.draftSlot) });
      }

      return asJson({ source: "store", slot: "published", namespace, profile: await store.readConfig(namespace, pointer.publishedSlot) });
    }),
  );

  // ── edit_profile ─────────────────────────────────────────────────────────────
  server.registerTool(
    "edit_profile",
    {
      title: "Edit the subject profile",
      description:
        "Replace the active grade/subject's SUBJECT PROFILE with a new full record — the two-phase, curator-gated way to change parsing/deliverables/coverage as DATA, with no redeploy (phase 2b). Pass the WHOLE profile object (get_profile first, edit, pass it back); this replaces, it does not patch. The profile is validated against its schema AT THIS STEP — a malformed profile is BLOCKED at dry-run (no token). A dry-run returns the before/after diff + any referential warnings (e.g. a rule naming a kind no node has) + a confirmationToken, changing nothing; confirm STAGES it onto the draft (a profile edit and curriculum edits share one draft). Nothing reaches generation until you publish_draft. firestore mode only — in bundle/dev mode the profile is the in-repo literal, edited in the repo.",
      inputSchema: {
        profile: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { profile: Record<string, unknown>; confirm?: boolean; confirmationToken?: string }) => {
      const adapter = getActiveAdapter();
      const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

      if (kgSource() !== "firestore") {
        return asJson({ error: "edit_profile is only available in firestore mode. In bundle/dev mode the subject profile is the in-repo literal — edit src/adapters/profiles/ and re-seed." });
      }

      // Capture the current graph's kinds for the referential check. Use the
      // draft slot when one is open (that's the surface the edit lands on),
      // else published.
      const store = getKgStore();
      const pointer = await store.readPointer(namespace);
      const slot = pointer?.draftSlot ?? pointer?.publishedSlot;
      const nodes = slot ? await store.listNodes(namespace, slot) : [];
      const knownKinds = new Set(nodes.map((n) => n.type));

      const result = await editProfileWithConfirm(namespace, a.profile, {
        confirm: a.confirm,
        token: a.confirmationToken,
        validate: makeValidator(namespace, knownKinds),
      });
      return asJson(result);
    }),
  );
}
