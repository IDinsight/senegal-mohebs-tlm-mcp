// ── Module: kg-store · internal ──────────────────────────────────────────────
// Two-phase confirm framework for GRAPH mutations. A mutation is a pure
// function over {nodes, edges}; the framework layers dry-run/confirm plumbing
// on top so every new mutation gets:
//   • preview → shared confirm envelope + per-mutation diff + warnings + a
//     confirmation token; changes NO state.
//   • confirm → token check (base version still current, nonce unused,
//     mutation + args match the preview), lazy draft creation if needed,
//     apply to the DRAFT slot only.
//
// STAKES: graph mutations STAGE a draft edit that is only visible to
// generation after a SEPARATE publish step. This is intentionally different
// from the document tools, which write live. The confirm envelope's `action`
// field must carry that distinction verbatim — see envelope shape below.
//
// LAYERING: the framework works on the raw {nodes, edges} shape (see
// SerializedGraph in curriculum/store-bridge.ts, mirrored here to keep
// kg-store dependency-free). Curriculum-shaped mutations that need the
// CurriculumModel serialize/deserialize on top of this — not inside it.
//
// The empty `validate` seam declared here is what #6 fills to make write-safety
// rules block confirmation entirely (errors → no token, no confirm path).

import { createHash, randomBytes } from "node:crypto";
import { getKgStore } from "./adapter.js";
import type { Slot, StoredEdge, StoredMeta, StoredNode } from "./types.js";

// The framework's working shape: nodes + edges without the storage-level slot
// tag (the store adds that at write time — see writeSlot). Kept structurally
// compatible with SerializedGraph from curriculum/store-bridge.ts so a
// curriculum-shaped mutation can be authored against the same shape.
export type MutationNode = Omit<StoredNode, "slot">;
export type MutationEdge = Omit<StoredEdge, "slot">;
export type MutationGraph = { nodes: MutationNode[]; edges: MutationEdge[] };

// Result of the empty validate seam. `errors` blocks confirmation entirely —
// the framework returns { errors, warnings } and NO token, so confirm has
// nothing to replay. `warnings` are surfaced in the envelope and do not block.
export type ValidationResult = { errors: string[]; warnings: string[] };

// A graph mutation is a pure function over {nodes, edges}. `describe(args)` is
// used in the envelope's `action` string, so it must state the stakes: what
// changes on the DRAFT, and remind the caller that publish is a separate step.
export interface GraphMutation<Args> {
  name: string;
  describe(args: Args): string;
  validate?(base: MutationGraph, args: Args): ValidationResult;
  apply(base: MutationGraph, args: Args): MutationGraph;
}

// Per-mutation diff. Keyed exclusively off the stable id (LC IRI for nodes,
// deterministic edgeId for edges). Friendly properties like chapitreNum live
// inside properties.raw and MUST NOT be used as identity — see #3 finding.
export type DiffEntry = { id: string; before?: unknown; after?: unknown };
export type GraphDiff = {
  nodes: { added: DiffEntry[]; removed: DiffEntry[]; changed: DiffEntry[] };
  edges: { added: DiffEntry[]; removed: DiffEntry[]; changed: DiffEntry[] };
};

// Return-type union for runGraphMutation. Discriminated on `phase` so callers
// can narrow without probing `in` operators. `phase: "preview"` and `"blocked"`
// share the common (needsConfirmation / action / message) fields with the
// document tools' envelope; `phase: "apply"` returns the effect of a confirm.
export type GraphPreviewResult = {
  phase: "preview";
  needsConfirmation: true;
  kind: "graphMutation";
  action: string;
  message: string;
  diff: GraphDiff;
  warnings: string[];
  confirmationToken: string;
};

// What a validation-blocked dry-run returns instead. No token: confirm has
// nothing to replay against errors. `warnings` are still surfaced so callers
// can present them alongside the block reason.
export type GraphBlockedResult = {
  phase: "blocked";
  needsConfirmation: false;
  kind: "graphMutation";
  errors: string[];
  warnings: string[];
};

// Confirm outcomes. `stale` covers every "base moved" case (pointer moved,
// published shifted while token was against published, draft shifted while
// token was against draft, or a draft appeared/disappeared under our feet).
// The caller is expected to retry with a fresh preview.
export type GraphApplyResult =
  | { phase: "apply"; ok: true; kind: "graphMutation"; applied: string; draftSlot: Slot; diff: GraphDiff }
  | { phase: "apply"; ok: false; kind: "graphMutation"; reason: "stale" | "replay" | "invalidToken" | "argsMismatch" | "mutationMismatch" | "unseeded"; message: string };

// ── Base-version computation ─────────────────────────────────────────────────
// The base version is a sha256 over the sorted-canonical JSON of the graph's
// nodes+edges. Sorting by id (both nodes and edges have stable ids) makes it
// robust against Firestore's non-guaranteed query order — the same logical
// graph always hashes to the same string.

const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
};

const hashGraph = (g: MutationGraph): string => {
  // Strip any accidental slot tags (readers might hand us StoredNode with the
  // slot field already stamped) so two graphs that differ only in slot don't
  // hash differently — the mutation cares about content, not storage tag.
  const nodes = [...g.nodes].map(({ ...n }) => { delete (n as { slot?: Slot }).slot; return n; })
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...g.edges].map(({ ...e }) => { delete (e as { slot?: Slot }).slot; return e; })
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(stableStringify({ nodes, edges })).digest("hex");
};

const hashArgs = (args: unknown): string =>
  createHash("sha256").update(stableStringify(args)).digest("hex");

// ── Token encoding ───────────────────────────────────────────────────────────
// Opaque to callers; the server treats it as a self-describing preview
// receipt. No signature: forgery isn't a threat model here because a forged
// token still has to match the current server state (base version) to be
// accepted, and mismatch always reduces to a `stale` retry.
type TokenPayload = {
  m: string;   // mutation name
  a: string;   // hashArgs(args)
  k: "onDraft" | "onPublished"; // which base the diff was computed against
  v: string;   // hashGraph(base) at preview time
  n: string;   // nonce (one-time use)
};

const encodeToken = (p: TokenPayload): string =>
  Buffer.from(JSON.stringify(p), "utf8").toString("base64url");

const decodeToken = (token: string): TokenPayload | null => {
  try {
    const p = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!p || typeof p !== "object") return null;
    const c = p as Record<string, unknown>;
    if (typeof c.m !== "string" || typeof c.a !== "string" || typeof c.v !== "string" || typeof c.n !== "string") return null;
    if (c.k !== "onDraft" && c.k !== "onPublished") return null;
    return { m: c.m, a: c.a, k: c.k, v: c.v, n: c.n };
  } catch { return null; }
};

// In-memory one-time-use nonce ledger. Scoped to the process (Cloud Run runs
// with an instance cap, so this is safe for the current deployment). If we
// scale out, this becomes per-instance and a replay across instances is
// theoretically possible — a follow-up would move this onto the pointer doc.
const consumedNonces = new Set<string>();
export const __resetMutationsForTest = (): void => { consumedNonces.clear(); };

// ── Diff computation ─────────────────────────────────────────────────────────
// Simple id-keyed diff: added, removed, and changed (deep property inequality).
// The `changed` entries carry before/after for the whole node/edge object,
// which is easier for a UI to render than a per-field patch and still small
// enough (nodes/edges are shallow).

const byId = <T extends { id: string }>(xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]));

const stripSlot = <T extends { slot?: Slot }>(x: T): Omit<T, "slot"> => {
  const { slot: _s, ...rest } = x;
  return rest;
};

function diffSide<T extends { id: string; slot?: Slot }>(before: T[], after: T[]): { added: DiffEntry[]; removed: DiffEntry[]; changed: DiffEntry[] } {
  const b = byId(before), a = byId(after);
  const added: DiffEntry[] = [], removed: DiffEntry[] = [], changed: DiffEntry[] = [];
  for (const [id, next] of a) {
    const prev = b.get(id);
    if (!prev) { added.push({ id, after: stripSlot(next) }); continue; }
    if (stableStringify(stripSlot(prev)) !== stableStringify(stripSlot(next))) {
      changed.push({ id, before: stripSlot(prev), after: stripSlot(next) });
    }
  }
  for (const [id, prev] of b) if (!a.has(id)) removed.push({ id, before: stripSlot(prev) });
  return { added, removed, changed };
}

export const diffGraphs = (before: MutationGraph, after: MutationGraph): GraphDiff => ({
  nodes: diffSide(before.nodes, after.nodes),
  edges: diffSide(before.edges, after.edges),
});

// ── Base-graph read ──────────────────────────────────────────────────────────
// Preview reads DRAFT if it exists (that's the surface the confirm will mutate),
// otherwise PUBLISHED (which becomes the draft's starting point on confirm).
// The `kind` tells confirm which invariant to re-check.

type BaseSnapshot = { graph: MutationGraph; kind: "onDraft" | "onPublished"; publishedSlot: Slot; meta: StoredMeta | null };

async function readBase(namespace: string): Promise<BaseSnapshot | { unseeded: true }> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer) return { unseeded: true };
  const targetSlot = pointer.draftSlot ?? pointer.publishedSlot;
  const [nodes, edges, meta] = await Promise.all([
    store.listNodes(namespace, targetSlot),
    store.listEdges(namespace, targetSlot),
    store.readMeta(namespace, targetSlot),
  ]);
  return {
    graph: { nodes: nodes.map(stripSlot), edges: edges.map(stripSlot) },
    kind: pointer.draftSlot ? "onDraft" : "onPublished",
    publishedSlot: pointer.publishedSlot,
    meta,
  };
}

// ── The framework entry point ────────────────────────────────────────────────
// One call handles both phases. Callers pass `confirm` (falsy on preview) and,
// on confirm, the token returned from the preview.

export type RunGraphMutationArgs<Args> = {
  namespace: string;
  mutation: GraphMutation<Args>;
  args: Args;
  confirm?: boolean;
  token?: string;
};

export async function runGraphMutation<Args>(
  input: RunGraphMutationArgs<Args>,
): Promise<GraphPreviewResult | GraphBlockedResult | GraphApplyResult> {
  const { namespace, mutation, args, confirm, token } = input;
  const store = getKgStore();

  // Compose the stakes-accurate action string exactly once. Every path that
  // surfaces an envelope pulls from here so the "stages a draft edit, publish
  // is a separate step" phrasing can't drift between preview and confirm.
  const action = `${mutation.describe(args)} — this STAGES a draft edit on namespace '${namespace}'; nothing reaches generation until you separately publish the draft`;

  // ── Confirm phase ────────────────────────────────────────────────────────
  if (confirm) {
    if (!token) return { phase: "apply", ok: false, kind: "graphMutation", reason: "invalidToken", message: "confirm=true was passed without a confirmationToken; re-run without confirm to get a fresh preview." };
    const payload = decodeToken(token);
    if (!payload) return { phase: "apply", ok: false, kind: "graphMutation", reason: "invalidToken", message: "confirmationToken is malformed; re-run without confirm to get a fresh preview." };
    if (payload.m !== mutation.name) return { phase: "apply", ok: false, kind: "graphMutation", reason: "mutationMismatch", message: `confirmationToken was issued for mutation '${payload.m}', not '${mutation.name}'.` };
    if (payload.a !== hashArgs(args)) return { phase: "apply", ok: false, kind: "graphMutation", reason: "argsMismatch", message: "args differ from the previewed values; re-run without confirm to preview the new args." };
    if (consumedNonces.has(payload.n)) return { phase: "apply", ok: false, kind: "graphMutation", reason: "replay", message: "This confirmation token has already been used; a mutation cannot be applied twice from one preview." };

    const snap = await readBase(namespace);
    if ("unseeded" in snap) return { phase: "apply", ok: false, kind: "graphMutation", reason: "unseeded", message: `Namespace '${namespace}' has no seed; run the seed before mutating.` };

    // A preview against 'published' expects (a) no draft has appeared since,
    // and (b) published hasn't shifted. A preview against 'draft' expects the
    // draft hash still matches. Any mismatch → stale, retry.
    if (snap.kind !== payload.k) {
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", message: `The base slot changed since preview (was '${payload.k}', now '${snap.kind}'); re-preview.` };
    }
    if (hashGraph(snap.graph) !== payload.v) {
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", message: `The base graph changed since preview; re-preview to see the current diff.` };
    }

    // Lazy draft creation. When the preview was against 'published' the draft
    // does not exist yet — createDraft is a byte-for-byte copy of published,
    // so the just-created draft equals what the preview mutated in memory
    // (already verified via the hash check above).
    if (snap.kind === "onPublished") await store.createDraft(namespace);
    const pointerAfter = await store.readPointer(namespace);
    if (!pointerAfter || !pointerAfter.draftSlot) {
      return { phase: "apply", ok: false, kind: "graphMutation", reason: "stale", message: `Draft could not be established for namespace '${namespace}'; re-preview.` };
    }
    const draftSlot = pointerAfter.draftSlot;

    // Re-read the draft (it's the exact bytes we hashed on the 'onDraft' path,
    // and the freshly-copied bytes on the 'onPublished' path). Apply the
    // mutation to it and writeSlot the new state.
    const [dn, de] = await Promise.all([store.listNodes(namespace, draftSlot), store.listEdges(namespace, draftSlot)]);
    const draftGraph: MutationGraph = { nodes: dn.map(stripSlot), edges: de.map(stripSlot) };
    const applied = mutation.apply(draftGraph, args);
    const diff = diffGraphs(draftGraph, applied);

    const meta: StoredMeta = {
      // adapterId survives from the previous meta so re-seed detection stays
      // meaningful; contentHash + counts reflect the new draft state.
      adapterId: snap.meta?.adapterId ?? "unknown",
      seededAt: snap.meta?.seededAt ?? "unknown",
      contentHash: hashGraph(applied),
      nodeCount: applied.nodes.length,
      edgeCount: applied.edges.length,
    };
    await store.writeSlot(namespace, draftSlot, { nodes: applied.nodes, edges: applied.edges, meta });

    // Consume the nonce LAST — if writeSlot throws, the token remains usable
    // for a legitimate retry after the operator fixes the underlying issue.
    consumedNonces.add(payload.n);
    return { phase: "apply", ok: true, kind: "graphMutation", applied: mutation.describe(args), draftSlot, diff };
  }

  // ── Preview phase ────────────────────────────────────────────────────────
  const snap = await readBase(namespace);
  if ("unseeded" in snap) {
    return { phase: "blocked", needsConfirmation: false, kind: "graphMutation", errors: [`Namespace '${namespace}' has no seed; run the seed before mutating.`], warnings: [] };
  }

  const validation: ValidationResult = mutation.validate
    ? mutation.validate(snap.graph, args)
    : { errors: [], warnings: [] };
  if (validation.errors.length > 0) {
    return { phase: "blocked", needsConfirmation: false, kind: "graphMutation", errors: validation.errors, warnings: validation.warnings };
  }

  const after = mutation.apply(snap.graph, args);
  const diff = diffGraphs(snap.graph, after);
  const issuedToken = encodeToken({
    m: mutation.name,
    a: hashArgs(args),
    k: snap.kind,
    v: hashGraph(snap.graph),
    n: randomBytes(16).toString("base64url"),
  });
  return {
    phase: "preview",
    needsConfirmation: true,
    kind: "graphMutation",
    action,
    message: `Do NOT proceed yet. Ask the user to confirm — about to ${action}. Once they explicitly agree, call this tool again with confirm: true AND the confirmationToken from this response.`,
    diff,
    warnings: validation.warnings,
    confirmationToken: issuedToken,
  };
}
