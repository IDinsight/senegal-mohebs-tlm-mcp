/*
 * Module: kg-store · internal
 *
 * The subject-profile config edit, as a two-phase staged edit on the SAME draft
 * as graph mutations. A profile is opaque JSON to this layer (see StoredConfig);
 * the schema lives in the adapters layer, so validation is INJECTED (the
 * `validate` callback) exactly the way runGraphMutation injects `coverage` — the
 * store never learns what a "deliverable" or "coverage rule" is.
 *
 * Shape mirrors publish-flow.ts, not runGraphMutation: a self-contained two-phase
 * op with its OWN small token space (own payload keys + own nonce ledger), a
 * state-hash CAS as the primary guard (the config moved since dry-run → STALE),
 * and lazy createDraft on confirm. It writes the draft config cell only; the cell
 * rides the shared pointer, so the graph's publish_draft promotes the profile
 * edit with the rest of the draft. See docs/design-notes/authorable-catalog.md 2b.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getKgStore } from "./adapter.js";
import { toAuditActor } from "./audit.js";
import { stableStringify } from "./mutations.js";
import type { AuditRecord, Slot, StoredConfig, ValidationResult } from "./types.js";
import { currentActor, type Actor } from "../actor.js";
import { authorize } from "../authz.js";

// Whole-object before/after — a profile is small, so a field-level patch would
// be more machinery than it earns. `before` is null the first time a namespace
// gets a profile (pre-config-layer seeds have no cell until re-seeded).
export type ConfigDiff = { before: StoredConfig | null; after: StoredConfig };

function snapshotActor(): { actor: Actor; auditActor: AuditRecord["actor"] } {
  const actor = currentActor();
  return { actor, auditActor: toAuditActor(actor) };
}

// Order-stable hash of a profile record — the token's base-version guard. null
// (no cell yet) hashes distinctly from any real profile so a first-write token
// can't be confused with an edit-from-existing token. Exported so publish-flow
// can fold the draft profile into its publish/discard token fingerprint (the
// profile rides the shared draft, so a publish must not miss a staged profile
// edit that landed since dry-run).
export const hashConfig = (config: StoredConfig | null): string =>
  createHash("sha256").update(config === null ? "null" : stableStringify(config)).digest("hex");

// ── Base read ────────────────────────────────────────────────────────────────
// Reads DRAFT config if a draft exists (the cell the confirm will overwrite),
// otherwise PUBLISHED (which becomes the draft's starting point on confirm) —
// the same draft-then-published resolution runGraphMutation uses for the graph.
type ConfigBase = {
  config: StoredConfig | null;
  kind: "onDraft" | "onPublished";
};

async function readConfigBase(namespace: string): Promise<ConfigBase | { unseeded: true }> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer) return { unseeded: true };
  const targetSlot = pointer.draftSlot ?? pointer.publishedSlot;
  const config = await store.readConfig(namespace, targetSlot);
  return { config, kind: pointer.draftSlot ? "onDraft" : "onPublished" };
}

// ── Token ──────────────────────────────────────────────────────────────────
// Own payload keys so a config token can never be replayed as a graph or draft
// token. No TTL: the `cv` state-hash CAS is the guard (config moved → STALE),
// matching publish-flow.ts's draft tokens.
type ConfigTokenPayload = {
  op: "editProfile";
  ns: string;
  k: "onDraft" | "onPublished"; // which base the diff was computed against
  cv: string;                    // hashConfig(base) at dry-run time
  pv: string;                    // hashConfig(proposed) — pins the exact profile to write
  n: string;                     // one-time nonce
};

const encodeToken = (p: ConfigTokenPayload): string =>
  Buffer.from(JSON.stringify(p), "utf8").toString("base64url");

const decodeToken = (token: string): ConfigTokenPayload | null => {
  try {
    const p = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!p || typeof p !== "object") return null;
    const c = p as Record<string, unknown>;
    if (c.op !== "editProfile") return null;
    if (c.k !== "onDraft" && c.k !== "onPublished") return null;
    if (typeof c.ns !== "string" || typeof c.cv !== "string" || typeof c.pv !== "string" || typeof c.n !== "string") return null;
    return { op: "editProfile", ns: c.ns, k: c.k, cv: c.cv, pv: c.pv, n: c.n };
  } catch { return null; }
};

// Sibling nonce ledger — separate space from the graph and draft nonces so the
// three token lifetimes never leak into each other. Process-scoped (same caveat
// as mutations.ts): a restart clears it, after which the state-hash CAS still
// prevents a double-apply (the landed edit moved the base → STALE).
const consumedConfigNonces = new Set<string>();
export const __resetConfigTokensForTest = (): void => { consumedConfigNonces.clear(); };

// ── Result types ─────────────────────────────────────────────────────────────
export type EditProfilePreview = {
  phase: "preview";
  kind: "editProfile";
  needsConfirmation: true;
  action: string;
  message: string;
  diff: ConfigDiff;
  warnings: string[];
  confirmationToken: string;
};
export type EditProfileResult =
  | EditProfilePreview
  | { phase: "blocked"; kind: "editProfile"; needsConfirmation: false; errors: string[]; warnings: string[] }
  | { phase: "unauthorized"; kind: "editProfile"; action: "apply"; reason: string }
  | { phase: "apply"; kind: "editProfile"; ok: true; draftSlot: Slot; diff: ConfigDiff; auditId: string }
  | { phase: "apply"; kind: "editProfile"; ok: false; reason: "stale" | "invalidToken" | "argsMismatch" | "unseeded" | "invalid"; message: string };

export type EditProfileOpts = {
  confirm?: boolean;
  token?: string;
  // Injected from the app layer (server tool): runs the SubjectProfile Zod guard
  // plus any referential checks. Errors block the token (dry-run) or the apply
  // (confirm); warnings ride the envelope and never block. Omitting it accepts
  // any JSON (used only where the caller has already validated).
  validate?: (proposed: StoredConfig) => ValidationResult;
};

// ── The two-phase entry point ────────────────────────────────────────────────
export async function editProfileWithConfirm(
  namespace: string,
  proposed: StoredConfig,
  opts: EditProfileOpts = {},
): Promise<EditProfileResult> {
  const store = getKgStore();
  const { actor, auditActor } = snapshotActor();

  const action = `replace the subject profile on namespace '${namespace}' — this STAGES a draft edit; nothing reaches generation until you separately publish the draft`;

  const auditBlocked = async (reason: string): Promise<void> => {
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", mutation: "edit_profile", reason,
    });
  };

  // Curator-gated for BOTH phases — same "apply" action as a graph edit, so a
  // profile edit and a curriculum edit share one permission. Enforced before any
  // read or token check so denials never leak the current profile.
  const authz = authorize(actor, "apply", namespace);
  if (!authz.ok) {
    await auditBlocked(`unauthorized: ${authz.reason}`);
    return { phase: "unauthorized", kind: "editProfile", action: "apply", reason: authz.reason };
  }

  const validated = opts.validate ? opts.validate(proposed) : { errors: [], warnings: [] };

  // ── Confirm phase ──────────────────────────────────────────────────────────
  if (opts.confirm) {
    if (!opts.token) return { phase: "apply", kind: "editProfile", ok: false, reason: "invalidToken", message: "confirm=true was passed without a confirmationToken; re-run without confirm to get a fresh preview." };
    const payload = decodeToken(opts.token);
    if (!payload) return { phase: "apply", kind: "editProfile", ok: false, reason: "invalidToken", message: "confirmationToken is not valid for edit_profile; re-run without confirm to get a fresh one." };
    if (payload.ns !== namespace) return { phase: "apply", kind: "editProfile", ok: false, reason: "invalidToken", message: `confirmationToken was issued for namespace '${payload.ns}', not '${namespace}'.` };
    if (payload.pv !== hashConfig(proposed)) { await auditBlocked("argsMismatch"); return { phase: "apply", kind: "editProfile", ok: false, reason: "argsMismatch", message: "the profile differs from the previewed one; re-run without confirm to preview the new profile." }; }
    if (consumedConfigNonces.has(payload.n)) { await auditBlocked("replay"); return { phase: "apply", kind: "editProfile", ok: false, reason: "invalidToken", message: "This confirmationToken has already been used; a profile edit cannot be applied twice from one preview." }; }

    // Re-validate at confirm — defence in depth against a caller that skipped
    // the dry-run's block. A malformed profile must never reach a slot.
    if (validated.errors.length > 0) { await auditBlocked(`validation: ${validated.errors[0]}`); return { phase: "apply", kind: "editProfile", ok: false, reason: "invalid", message: validated.errors.join("; ") }; }

    const base = await readConfigBase(namespace);
    if ("unseeded" in base) { await auditBlocked("unseeded"); return { phase: "apply", kind: "editProfile", ok: false, reason: "unseeded", message: `Namespace '${namespace}' has no seed; run the seed before editing its profile.` }; }
    // State-hash CAS: base kind or content moved since dry-run → re-preview.
    if (base.kind !== payload.k || hashConfig(base.config) !== payload.cv) {
      await auditBlocked("stale: base config changed");
      return { phase: "apply", kind: "editProfile", ok: false, reason: "stale", message: "The profile (or its draft state) changed since preview; re-run without confirm to review the current diff." };
    }

    // Lazy draft creation: when previewed against published, open a draft (a
    // byte-for-byte copy of published, config cell included) before writing.
    if (base.kind === "onPublished") {
      await store.createDraft(namespace, {
        id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
        namespace, eventType: "createDraft", baseVersion: hashConfig(base.config),
      });
    }
    const pointerAfter = await store.readPointer(namespace);
    if (!pointerAfter || !pointerAfter.draftSlot) {
      await auditBlocked("stale: draft could not be established");
      return { phase: "apply", kind: "editProfile", ok: false, reason: "stale", message: `Draft could not be established for namespace '${namespace}'; re-preview.` };
    }
    const draftSlot = pointerAfter.draftSlot;

    const diff: ConfigDiff = { before: base.config, after: proposed };
    const applyRec: AuditRecord = {
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "apply", mutation: "edit_profile",
      baseVersion: hashConfig(base.config), resultingVersion: hashConfig(proposed),
    };
    await store.writeConfig(namespace, draftSlot, proposed, applyRec);
    consumedConfigNonces.add(payload.n);
    return { phase: "apply", kind: "editProfile", ok: true, draftSlot, diff, auditId: applyRec.id };
  }

  // ── Dry-run phase ────────────────────────────────────────────────────────
  const base = await readConfigBase(namespace);
  if ("unseeded" in base) {
    await auditBlocked("unseeded (preview)");
    return { phase: "blocked", kind: "editProfile", needsConfirmation: false, errors: [`Namespace '${namespace}' has no seed; run the seed before editing its profile.`], warnings: [] };
  }
  // A malformed profile blocks the token — nothing to confirm against errors.
  if (validated.errors.length > 0) {
    await auditBlocked(`validation: ${validated.errors[0]}`);
    return { phase: "blocked", kind: "editProfile", needsConfirmation: false, errors: validated.errors, warnings: validated.warnings };
  }

  const token = encodeToken({
    op: "editProfile", ns: namespace, k: base.kind,
    cv: hashConfig(base.config), pv: hashConfig(proposed),
    n: randomBytes(16).toString("base64url"),
  });
  return {
    phase: "preview", kind: "editProfile", needsConfirmation: true,
    action,
    message: `Do NOT proceed yet. Ask the user to confirm — about to ${action}. Once they explicitly agree, call this tool again with confirm: true AND the confirmationToken from this response.`,
    diff: { before: base.config, after: proposed },
    warnings: validated.warnings,
    confirmationToken: token,
  };
}

// ── Profile diff for the whole-draft view (diff_draft / publish_draft) ────────
// A staged profile edit rides the shared draft, so an approver must SEE it
// before publishing. Returns the published→draft profile change (or `changed:
// false` when the draft's profile equals published, or there's no draft).
export type WholeDraftProfileDiff = { changed: boolean; before?: StoredConfig | null; after?: StoredConfig | null };

export async function diffProfile(namespace: string): Promise<WholeDraftProfileDiff> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer || !pointer.draftSlot) return { changed: false };
  const [published, draft] = await Promise.all([
    store.readConfig(namespace, pointer.publishedSlot),
    store.readConfig(namespace, pointer.draftSlot),
  ]);
  if (hashConfig(published) === hashConfig(draft)) return { changed: false };
  return { changed: true, before: published, after: draft };
}
