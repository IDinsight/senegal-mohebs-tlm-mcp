// ── Module: kg-store · internal ──────────────────────────────────────────────
// The draft lifecycle: promote (publish) and throw-away (discard) of the
// double-buffered draft slot, plus the whole-draft diff that feeds them.
//
// Two layers live here:
//   • Raw wrappers — publishDraft / discardDraft — wrap the store's lifecycle
//     primitives so #8's role check and #7's audit both fire, atomically with
//     the state write (the store commits both in one Firestore transaction).
//     Tests and user-facing tools go through these, NEVER `store.publishDraft`
//     / `store.discardDraft` directly — that's how enforcement stays complete.
//   • Two-phase confirm wrappers — publishDraftWithConfirm /
//     discardDraftWithConfirm — layer dry-run/confirm plumbing (a draft-level
//     concurrency token) on top, mirroring the per-mutation two-phase flow in
//     mutations.ts but with their own token space.
//
// This module depends one-way on mutations.ts (the framework) for the graph
// hash / slot-strip / diff helpers; mutations.ts never imports back.

import { randomBytes, randomUUID } from "node:crypto";
import { getKgStore } from "./adapter.js";
import { toAuditActor } from "./audit.js";
import { diffGraphs, hashGraph, stripSlot } from "./mutations.js";
import type { AuditRecord, GraphDiff, MutationGraph, Slot } from "./types.js";
import { currentActor, type Actor } from "../actor.js";
import { authorize, selfApproveAllowed } from "../authz.js";

// ── Lifecycle wrappers: publishDraft / discardDraft ─────────────────────────

export type PublishResult =
  | { ok: true; publishedSlot: Slot; auditId: string; selfAuthored: boolean }
  | { ok: false; reason: string };

export type DiscardResult =
  | { ok: true; auditId: string; discardedApplyIds: string[] }
  | { ok: false; reason: string };

// Snapshot the actor and its audit-friendly projection. Same shape used by
// runGraphMutation — kept here rather than exported so the lifecycle
// wrappers don't reach into runGraphMutation's internals.
function snapshotActor(): { actor: Actor; auditActor: AuditRecord["actor"] } {
  const actor = currentActor();
  return { actor, auditActor: toAuditActor(actor) };
}

// The apply records that would be promoted by publishing / discarded by
// discarding the current draft. "Current draft" = everything since the
// most recent createDraft record for this namespace (that createDraft is
// what opened the draft the store is holding right now).
async function currentDraftApplies(namespace: string): Promise<AuditRecord[]> {
  const store = getKgStore();
  const events = await store.listAudit({ namespace });
  // listAudit is newest-first. The first createDraft we hit is the one
  // that opened the currently-open draft.
  const created = events.find((r) => r.eventType === "createDraft");
  if (!created) return []; // no draft ever created here — publish will fail at the store anyway
  return events.filter((r) => r.eventType === "apply" && r.ts >= created.ts);
}

// `warningsAtPublish` (optional, #13) is the coverage warnings the caller
// observed on the draft at publish time — recorded verbatim on the publish
// audit for traceability. It never affects the outcome (warnings don't block);
// the two-phase wrapper computes it and hands it down.
export async function publishDraft(namespace: string, warningsAtPublish?: string[]): Promise<PublishResult> {
  const store = getKgStore();
  const { actor, auditActor } = snapshotActor();

  // Denial → typed error + blocked audit + no state change. Same shape as
  // runGraphMutation's unauthorized path.
  const authz = authorize(actor, "publish", namespace);
  if (!authz.ok) {
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${authz.reason}`,
    });
    return { ok: false, reason: authz.reason };
  }

  // Look up which applies would be promoted, and check self-authorship.
  // The `selfAuthored` flag is ALWAYS recorded on the publish audit so an
  // auditor sees self-approval even when the config permits it (see #8
  // decision (b)); only if the strict config is set does self-authorship
  // block the publish.
  const promoted = await currentDraftApplies(namespace);
  const promotedIds = promoted.map((r) => r.id);
  const selfAuthored = promoted.some((r) => r.actor.id === actor.id);

  if (selfAuthored && !selfApproveAllowed()) {
    const reason = "separation-of-duties: approver cannot publish self-authored edits (TLM_ALLOW_SELF_APPROVE=0)";
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${reason}`,
    });
    return { ok: false, reason };
  }

  // Read the pointer so we can name the base/resulting versions. The
  // pointer flip is atomic in the store — we're just recording the two
  // hashes for later reference.
  const pointer = await store.readPointer(namespace);
  if (!pointer || !pointer.draftSlot) {
    // Not an authz failure — just no draft to promote. Let the store
    // surface it, but audit it as blocked for consistency.
    const reason = "no draft to publish";
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason,
    });
    return { ok: false, reason };
  }
  const [pubN, pubE, drN, drE] = await Promise.all([
    store.listNodes(namespace, pointer.publishedSlot),
    store.listEdges(namespace, pointer.publishedSlot),
    store.listNodes(namespace, pointer.draftSlot),
    store.listEdges(namespace, pointer.draftSlot),
  ]);
  const baseVersion = hashGraph({ nodes: pubN.map(stripSlot), edges: pubE.map(stripSlot) });
  const resultingVersion = hashGraph({ nodes: drN.map(stripSlot), edges: drE.map(stripSlot) });

  const auditId = randomUUID();
  const rec: AuditRecord = {
    id: auditId, ts: new Date().toISOString(), actor: auditActor,
    namespace, eventType: "publish",
    baseVersion, resultingVersion,
    promotedApplyIds: promotedIds,
    selfAuthored,
    // Record coverage warnings only when the caller computed them (they had a
    // coverage hook). Firestore rejects `undefined`, so omit the key entirely
    // rather than write undefined when none were supplied.
    ...(warningsAtPublish ? { warningsAtPublish } : {}),
  };
  await store.publishDraft(namespace, rec);
  const newPointer = await store.readPointer(namespace);
  return { ok: true, publishedSlot: newPointer!.publishedSlot, auditId, selfAuthored };
}

export async function discardDraft(namespace: string): Promise<DiscardResult> {
  const store = getKgStore();
  const { actor, auditActor } = snapshotActor();

  const authz = authorize(actor, "discard", namespace);
  if (!authz.ok) {
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${authz.reason}`,
    });
    return { ok: false, reason: authz.reason };
  }

  const promoted = await currentDraftApplies(namespace);
  const discardedApplyIds = promoted.map((r) => r.id);

  // Base version = published slot's hash at discard time. Nothing changes on
  // published, but recording the hash gives audit reviews a fixed anchor.
  const pointer = await store.readPointer(namespace);
  let baseVersion: string | undefined;
  if (pointer) {
    const [n, e] = await Promise.all([
      store.listNodes(namespace, pointer.publishedSlot),
      store.listEdges(namespace, pointer.publishedSlot),
    ]);
    baseVersion = hashGraph({ nodes: n.map(stripSlot), edges: e.map(stripSlot) });
  }

  const auditId = randomUUID();
  const rec: AuditRecord = {
    id: auditId, ts: new Date().toISOString(), actor: auditActor,
    namespace, eventType: "discard",
    baseVersion, discardedApplyIds,
  };
  await store.discardDraft(namespace, rec);
  return { ok: true, auditId, discardedApplyIds };
}

// ── Whole-draft diff (#9's diff_draft) ──────────────────────────────────────
// Walks published vs draft structurally, keyed by stable id. This is
// distinct from #5's per-mutation diff (returned by runGraphMutation) —
// per-mutation shows what ONE apply changed; whole-draft shows the
// cumulative diff of every edit that has landed on the current draft.
// Structural recompute is the source of truth per decision (a) — audit is
// a log, not a state oracle.
export type WholeDraftDiff = {
  hasDraft: boolean;
  publishedVersion?: string;
  draftVersion?: string;
  diff?: GraphDiff;
  // Coverage/consistency warnings over the WHOLE draft (#13). This is the
  // approver's pre-publish view — exactly where "this chapter has no bilan"
  // should surface. Present (possibly empty) whenever a draft exists and a
  // coverage hook was supplied; omitted when there's no draft. Warnings NEVER
  // block publish.
  warnings?: string[];
};

// `coverage` is the active adapter's subject-aware hook, injected by the server
// layer (same as runGraphMutation) so this function stays subject-agnostic.
// When omitted, no warnings are computed (callers that only need the diff).
export async function diffDraft(
  namespace: string,
  coverage?: (graph: MutationGraph) => string[],
): Promise<WholeDraftDiff> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer || !pointer.draftSlot) return { hasDraft: false };
  const [pubN, pubE, drN, drE] = await Promise.all([
    store.listNodes(namespace, pointer.publishedSlot),
    store.listEdges(namespace, pointer.publishedSlot),
    store.listNodes(namespace, pointer.draftSlot),
    store.listEdges(namespace, pointer.draftSlot),
  ]);
  const published: MutationGraph = { nodes: pubN.map(stripSlot), edges: pubE.map(stripSlot) };
  const draft: MutationGraph = { nodes: drN.map(stripSlot), edges: drE.map(stripSlot) };
  return {
    hasDraft: true,
    publishedVersion: hashGraph(published),
    draftVersion: hashGraph(draft),
    diff: diffGraphs(published, draft),
    warnings: coverage ? coverage(draft) : [],
  };
}

// ── Draft-level concurrency token for publish_draft / discard_draft ─────────
// Distinct from #5's per-mutation token — same self-describing receipt
// shape (base64url JSON, hash + nonce) but its own payload keys so one
// can't be replayed as the other. A dry-run mints a token capturing the
// draft version shown; confirm rejects if the draft moved since.
type DraftTokenPayload = {
  op: "publish" | "discard";
  ns: string;
  dv: string;   // hashGraph(draft) at dry-run time
  n: string;    // nonce
};

const encodeDraftToken = (p: DraftTokenPayload): string =>
  Buffer.from(JSON.stringify(p), "utf8").toString("base64url");

const decodeDraftToken = (token: string): DraftTokenPayload | null => {
  try {
    const p = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!p || typeof p !== "object") return null;
    const c = p as Record<string, unknown>;
    if (c.op !== "publish" && c.op !== "discard") return null;
    if (typeof c.ns !== "string" || typeof c.dv !== "string" || typeof c.n !== "string") return null;
    return { op: c.op, ns: c.ns, dv: c.dv, n: c.n };
  } catch { return null; }
};

// Second, sibling nonce ledger — keeps draft-level tokens in a separate
// space from #5's per-mutation nonces so the two lifetimes don't leak
// into each other. Same in-memory-per-process caveat.
const consumedDraftNonces = new Set<string>();
export const __resetDraftTokensForTest = (): void => { consumedDraftNonces.clear(); };

// ── publish_draft (two-phase) ────────────────────────────────────────────────
// Dry-run: authorize as publish → compute whole-draft diff → issue token,
// no state change. Confirm: authorize again → verify token + draft still
// current → delegate to publishDraft() which does the atomic promote +
// audit. The self-approve check runs inside publishDraft — no need to
// duplicate it here.
export type PublishConfirmPreview = {
  phase: "preview";
  kind: "publishDraft";
  needsConfirmation: true;
  action: string;
  message: string;
  hasDraft: boolean;
  publishedVersion?: string;
  draftVersion?: string;
  diff?: GraphDiff;
  warnings?: string[];          // coverage warnings on the draft (#13) — inform, never block
  confirmationToken?: string;   // absent when there's nothing to publish
};
export type PublishConfirmResult =
  | PublishConfirmPreview
  | { phase: "unauthorized"; kind: "publishDraft"; action: "publish"; reason: string }
  | { phase: "commit"; kind: "publishDraft"; ok: true; publishedSlot: Slot; auditId: string; selfAuthored: boolean; warningsAtPublish?: string[] }
  | { phase: "commit"; kind: "publishDraft"; ok: false; reason: string };

export async function publishDraftWithConfirm(
  namespace: string,
  opts: { confirm?: boolean; token?: string; coverage?: (graph: MutationGraph) => string[] } = {},
): Promise<PublishConfirmResult> {
  const store = getKgStore();
  const { actor, auditActor } = snapshotActor();

  // Authorize FIRST at both phases, so denials never leak the draft's diff.
  const authz = authorize(actor, "publish", namespace);
  if (!authz.ok) {
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${authz.reason}`,
    });
    return { phase: "unauthorized", kind: "publishDraft", action: "publish", reason: authz.reason };
  }

  // ── Confirm phase ───────────────────────────────────────────────────────
  if (opts.confirm) {
    if (!opts.token) return { phase: "commit", kind: "publishDraft", ok: false, reason: "confirm=true was passed without a confirmationToken; re-run without confirm to get a fresh preview." };
    const payload = decodeDraftToken(opts.token);
    if (!payload || payload.op !== "publish") return { phase: "commit", kind: "publishDraft", ok: false, reason: "confirmationToken is not valid for publish_draft; re-run without confirm to get a fresh one." };
    if (payload.ns !== namespace) return { phase: "commit", kind: "publishDraft", ok: false, reason: `confirmationToken was issued for namespace '${payload.ns}', not '${namespace}'.` };
    if (consumedDraftNonces.has(payload.n)) return { phase: "commit", kind: "publishDraft", ok: false, reason: "This confirmationToken has already been used." };

    // Draft-still-current check: recompute the draft hash and compare
    // against the token. If it moved (someone applied since dry-run),
    // reject — a stale publish could promote unexpected edits. Pass the
    // coverage hook so we can record the warnings-at-publish on the audit.
    const current = await diffDraft(namespace, opts.coverage);
    if (!current.hasDraft) return { phase: "commit", kind: "publishDraft", ok: false, reason: "no draft to publish" };
    if (current.draftVersion !== payload.dv) return { phase: "commit", kind: "publishDraft", ok: false, reason: "the draft moved since dry-run — re-preview to see the current diff before publishing" };

    // Delegate to the atomic primitive. It runs its own authz (redundant
    // but cheap and defence-in-depth) and its own self-approve check. The
    // warnings we observed are recorded on the publish audit — they never
    // block (approver's call), they annotate the trail.
    const warningsAtPublish = opts.coverage ? (current.warnings ?? []) : undefined;
    const result = await publishDraft(namespace, warningsAtPublish);
    consumedDraftNonces.add(payload.n);
    if (!result.ok) return { phase: "commit", kind: "publishDraft", ok: false, reason: result.reason };
    return { phase: "commit", kind: "publishDraft", ok: true, publishedSlot: result.publishedSlot, auditId: result.auditId, selfAuthored: result.selfAuthored, ...(warningsAtPublish ? { warningsAtPublish } : {}) };
  }

  // ── Dry-run phase ───────────────────────────────────────────────────────
  const snap = await diffDraft(namespace, opts.coverage);
  if (!snap.hasDraft) {
    // Nothing to publish. Return a preview envelope shape but with no token.
    return {
      phase: "preview", kind: "publishDraft", needsConfirmation: true,
      action: `publish namespace '${namespace}' — no draft exists, nothing to promote`,
      message: `There is no draft to publish for '${namespace}'. Make an edit first (upsert_property or similar), then dry-run publish_draft again.`,
      hasDraft: false,
    };
  }
  const token = encodeDraftToken({ op: "publish", ns: namespace, dv: snap.draftVersion!, n: randomBytes(16).toString("base64url") });
  const changeCount = (snap.diff!.nodes.added.length + snap.diff!.nodes.changed.length + snap.diff!.nodes.removed.length +
                       snap.diff!.edges.added.length + snap.diff!.edges.changed.length + snap.diff!.edges.removed.length);
  return {
    phase: "preview", kind: "publishDraft", needsConfirmation: true,
    action: `PROMOTE the draft on namespace '${namespace}' to LIVE (published) — ${changeCount} change(s) will be visible to generation immediately after this step`,
    message: `Do NOT proceed yet. Ask the user to confirm — about to promote ${changeCount} draft change(s) to published on '${namespace}'. Once they explicitly agree, call this tool again with confirm: true AND the confirmationToken from this response.`,
    hasDraft: true,
    publishedVersion: snap.publishedVersion,
    draftVersion: snap.draftVersion,
    diff: snap.diff,
    warnings: snap.warnings,
    confirmationToken: token,
  };
}

// ── discard_draft (two-phase) ────────────────────────────────────────────────
// Mirrors publish_draft's shape. Curator or approver may call.
export type DiscardConfirmPreview = {
  phase: "preview";
  kind: "discardDraft";
  needsConfirmation: true;
  action: string;
  message: string;
  hasDraft: boolean;
  draftVersion?: string;
  diff?: GraphDiff;
  confirmationToken?: string;
};
export type DiscardConfirmResult =
  | DiscardConfirmPreview
  | { phase: "unauthorized"; kind: "discardDraft"; action: "discard"; reason: string }
  | { phase: "commit"; kind: "discardDraft"; ok: true; auditId: string; discardedApplyIds: string[] }
  | { phase: "commit"; kind: "discardDraft"; ok: false; reason: string };

export async function discardDraftWithConfirm(
  namespace: string,
  opts: { confirm?: boolean; token?: string } = {},
): Promise<DiscardConfirmResult> {
  const store = getKgStore();
  const { actor, auditActor } = snapshotActor();

  const authz = authorize(actor, "discard", namespace);
  if (!authz.ok) {
    await store.appendAudit({
      id: randomUUID(), ts: new Date().toISOString(), actor: auditActor,
      namespace, eventType: "blocked", reason: `unauthorized: ${authz.reason}`,
    });
    return { phase: "unauthorized", kind: "discardDraft", action: "discard", reason: authz.reason };
  }

  if (opts.confirm) {
    if (!opts.token) return { phase: "commit", kind: "discardDraft", ok: false, reason: "confirm=true was passed without a confirmationToken; re-run without confirm to get a fresh preview." };
    const payload = decodeDraftToken(opts.token);
    if (!payload || payload.op !== "discard") return { phase: "commit", kind: "discardDraft", ok: false, reason: "confirmationToken is not valid for discard_draft; re-run without confirm to get a fresh one." };
    if (payload.ns !== namespace) return { phase: "commit", kind: "discardDraft", ok: false, reason: `confirmationToken was issued for namespace '${payload.ns}', not '${namespace}'.` };
    if (consumedDraftNonces.has(payload.n)) return { phase: "commit", kind: "discardDraft", ok: false, reason: "This confirmationToken has already been used." };

    const current = await diffDraft(namespace);
    if (!current.hasDraft) return { phase: "commit", kind: "discardDraft", ok: false, reason: "no draft to discard" };
    if (current.draftVersion !== payload.dv) return { phase: "commit", kind: "discardDraft", ok: false, reason: "the draft moved since dry-run — re-preview before discarding" };

    const result = await discardDraft(namespace);
    consumedDraftNonces.add(payload.n);
    if (!result.ok) return { phase: "commit", kind: "discardDraft", ok: false, reason: result.reason };
    return { phase: "commit", kind: "discardDraft", ok: true, auditId: result.auditId, discardedApplyIds: result.discardedApplyIds };
  }

  const snap = await diffDraft(namespace);
  if (!snap.hasDraft) {
    return {
      phase: "preview", kind: "discardDraft", needsConfirmation: true,
      action: `discard the draft on namespace '${namespace}' — no draft exists, nothing to discard`,
      message: `There is no draft to discard for '${namespace}'.`,
      hasDraft: false,
    };
  }
  const token = encodeDraftToken({ op: "discard", ns: namespace, dv: snap.draftVersion!, n: randomBytes(16).toString("base64url") });
  const changeCount = (snap.diff!.nodes.added.length + snap.diff!.nodes.changed.length + snap.diff!.nodes.removed.length +
                       snap.diff!.edges.added.length + snap.diff!.edges.changed.length + snap.diff!.edges.removed.length);
  return {
    phase: "preview", kind: "discardDraft", needsConfirmation: true,
    action: `DISCARD ${changeCount} draft change(s) on namespace '${namespace}' — the draft will be thrown away and published is untouched`,
    message: `Do NOT proceed yet. Ask the user to confirm — about to DISCARD ${changeCount} draft change(s) on '${namespace}'. Once they explicitly agree, call this tool again with confirm: true AND the confirmationToken from this response.`,
    hasDraft: true,
    draftVersion: snap.draftVersion,
    diff: snap.diff,
    confirmationToken: token,
  };
}
