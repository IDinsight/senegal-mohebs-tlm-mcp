/*
 * Module: server · tool group: edge + deletion verbs
 *
 * The edge/deletion verbs — create_edges, delete_edges, delete_nodes. Node
 * CREATION is add_nodes (server/authoring.ts); create_edges is the escape hatch
 * for edges add_nodes doesn't set (usesRoutine, buildsTowards, relatesTo,
 * hasDependency, an extra hasEducationalAlignment). All share the pattern:
 *
 *   • Two-phase confirm (dry-run returns diff + confirmationToken; confirm
 *     applies to the DRAFT only).
 *   • Referential-integrity rules always fire (id-immutable, no dangling edge).
 *   • Every apply and every denial is audited; all gated on curator/approver.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { kgNamespace, deleteEdges, deleteNodes } from "../kg-store/index.js";
import { createEdges } from "../kg-recipes/index.js";
import { runBatchMutation, type ReturnMode } from "./batch.js";
import { idempotencyPayloadHash } from "./idempotency.js";
import { runCatalogWrite } from "./catalog-target.js";

function activeNamespace(): string {
  const a = getActiveAdapter();
  return kgNamespace(activeWorkspace(), a.grade, a.subject);
}

const JsonValue = z.any();

type CreateEdgesArgs = {
  edges?: Array<{ edgeType: string; fromId: string; toId: string; properties?: Record<string, unknown> }>;
  confirm?: boolean;
  confirmationToken?: string;
  returnMode?: ReturnMode;
  idempotencyKey?: string;
  catalog?: string;   // write to a catalog library instead of the active subject
};

// The create_edges core, exported so tests drive the real logic. Routes the batch
// to the active subject's namespace, or — when `catalog` is set — to a catalog
// library, which also publishes on confirm (see catalog-target.ts).
export async function runCreateEdges(a: CreateEdgesArgs): Promise<Record<string, unknown>> {
  const createInNamespace = (namespace: string) => createEdgesInNamespace(namespace, a);
  if (a.catalog) {
    return runCatalogWrite(a.catalog, a.confirm, createInNamespace);
  }
  return createInNamespace(activeNamespace());
}

// Normalizes each edge's properties, then delegates response shaping +
// idempotency to runBatchMutation (no minted ids for edges, so `extra` is empty).
// Namespace-agnostic so the same path serves a subject and a catalog write.
async function createEdgesInNamespace(namespace: string, a: CreateEdgesArgs): Promise<Record<string, unknown>> {
  // Token-only confirm: caller sends confirm+token with no `edges`. The parked
  // context (built on dry-run) holds the normalised list, so runBatchMutation
  // reconstructs from it — placeholder args/hash here are overwritten.
  if (a.confirm && !a.edges) {
    return runBatchMutation({
      namespace, mutation: createEdges,
      args: { namespace, edges: [] },
      confirm: true, token: a.confirmationToken,
      returnMode: a.returnMode ?? "summary",
      idempotencyKey: a.idempotencyKey,
      payloadHash: "",
      extra: {},
      storePayload: true,
    });
  }

  const normalizedEdges = (a.edges ?? []).map((edge) => ({ ...edge, properties: edge.properties ?? {} }));
  return runBatchMutation({
    namespace,
    mutation: createEdges,
    args: { namespace, edges: normalizedEdges },
    confirm: a.confirm,
    token: a.confirmationToken,
    returnMode: a.returnMode ?? "summary",
    idempotencyKey: a.idempotencyKey,
    payloadHash: idempotencyPayloadHash(normalizedEdges),
    extra: {},
    storePayload: true,
  });
}

// The delete_edges core, exported so tests drive the real logic. Removes one edge
// or many by id in one atomic batch; no minted ids, so `extra` is empty.
export async function runDeleteEdges(a: {
  edgeIds: string[];
  confirm?: boolean;
  confirmationToken?: string;
  returnMode?: ReturnMode;
  idempotencyKey?: string;
}): Promise<Record<string, unknown>> {
  const namespace = activeNamespace();
  return runBatchMutation({
    namespace,
    mutation: deleteEdges,
    args: { edgeIds: a.edgeIds },
    confirm: a.confirm,
    token: a.confirmationToken,
    returnMode: a.returnMode ?? "summary",
    idempotencyKey: a.idempotencyKey,
    payloadHash: idempotencyPayloadHash(a.edgeIds),
    extra: {},
  });
}

// The delete_nodes core, exported so tests drive the real logic. Removes one node
// or many — each with its dependent subtree (cascade) — in one atomic batch.
export async function runDeleteNodes(a: {
  nodeIds: string[];
  confirm?: boolean;
  confirmationToken?: string;
  returnMode?: ReturnMode;
  idempotencyKey?: string;
}): Promise<Record<string, unknown>> {
  const namespace = activeNamespace();
  return runBatchMutation({
    namespace,
    mutation: deleteNodes,
    args: { nodeIds: a.nodeIds },
    confirm: a.confirm,
    token: a.confirmationToken,
    returnMode: a.returnMode ?? "summary",
    idempotencyKey: a.idempotencyKey,
    payloadHash: idempotencyPayloadHash(a.nodeIds),
    extra: {},
  });
}

export function registerStructuralTools(server: McpServer) {
  // ── create_edges ───────────────────────────────────────────────────────────
  server.registerTool(
    "create_edges",
    {
      title: "Create edges (one or many) in one batch",
      description:
        "The edge-creation tool — add ONE edge or MANY in one atomic draft edit (it replaced the single create_edge). Use it for edges add_nodes doesn't set: `usesRoutine` (apply a routine to a Lesson/Course/Activity), `buildsTowards` / `relatesTo` / `hasDependency` (prerequisites), or an extra `hasEducationalAlignment`. Each `edges[i]` has `edgeType`, `fromId`, `toId`, and optional `properties`; both endpoints must already exist in the draft (ids minted by a prior committed add_nodes are valid). Edge ids are deterministic (`<type>:<from>-><to>`); a duplicate triple is rejected — duplicate detection spans BOTH the batch and the current draft. ALL-OR-NOTHING: the dry-run validates every edge and returns ONE confirmationToken; any item error blocks the whole batch (no partial apply). When the dry-run reports `payloadStored:true` (a large batch held server-side), confirm with ONLY confirm:true + the token — do NOT re-send `edges`; otherwise re-send `edges` verbatim with confirm:true + the token. Edge-type legality across labels is a reviewer judgment at publish, not enforced here. " +
        "`returnMode` (default 'summary') controls the response: 'summary' returns `counts` {nodesAdded,edgesAdded,nodesChanged,nodesRemoved,edgesRemoved} instead of the full diff; 'full' also attaches the whole `diff`. " +
        "`idempotencyKey` (optional): a unique key (a UUID) makes a RETRIED confirm safe — same key + same payload replays the first apply's summary with `replayed:true` (no double-apply/audit) instead of REPLAY; same key + different payload is rejected as IDEMPOTENCY_KEY_MISMATCH. Namespace-scoped, 24h TTL. Omit for strict single-use. DRAFT edit. " +
        "`catalog` (optional) wires the edges inside a CATALOG LIBRARY instead of the active subject graph — pass 'workspace' (your own library), 'shared', or a workspace id; crossing libraries needs super_admin. Confirming PUBLISHES the library live in one step (catalogs are not enterable, so no publish_draft), and `catalog` must be RE-SENT on the confirm.",
      inputSchema: {
        // Required on dry-run; omitted on a token-only confirm (large batch
        // held server-side — the parked context reconstructs the list).
        edges: z.array(
          z.object({
            edgeType: z.string(),
            fromId: z.string(),
            toId: z.string(),
            properties: z.record(JsonValue).optional(),
          }),
        ).optional(),
        returnMode: z.enum(["summary", "full"]).optional(),
        idempotencyKey: z.string().optional(),
        catalog: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: CreateEdgesArgs) => asJson(await runCreateEdges(a))),
  );

  // ── delete_edges ───────────────────────────────────────────────────────────
  server.registerTool(
    "delete_edges",
    {
      title: "Delete edges (one or many) in one batch",
      description:
        "Remove ONE edge or MANY by id in one atomic draft edit. Each `edgeIds[i]` is a deterministic edge id (`<type>:<from>-><to>`) — get them from a prior create_edges preview, from diff_draft, or from the graph. Removing an edge cannot orphan a node (the node just becomes less connected); the dangling-edge check only cares about surviving edges. Use this to detach a node before delete_nodes if you want to keep the (now-detached) subtree. ALL-OR-NOTHING: the dry-run validates every id and returns ONE confirmationToken; any missing id (or an id listed twice) blocks the whole batch (no partial delete). To confirm, call again with confirm:true and the token. " +
        "`returnMode` (default 'summary') controls the response: 'summary' returns `counts` {nodesAdded,edgesAdded,nodesChanged,nodesRemoved,edgesRemoved} instead of the full diff; 'full' also attaches the whole `diff`. " +
        "`idempotencyKey` (optional): a unique key (a UUID) makes a RETRIED confirm safe — same key + same payload replays the first apply's summary with `replayed:true` instead of REPLAY; same key + different payload is rejected as IDEMPOTENCY_KEY_MISMATCH. Namespace-scoped, 24h TTL. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        edgeIds: z.array(z.string()),
        returnMode: z.enum(["summary", "full"]).optional(),
        idempotencyKey: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: {
      edgeIds: string[]; confirm?: boolean; confirmationToken?: string; returnMode?: ReturnMode; idempotencyKey?: string;
    }) => asJson(await runDeleteEdges(a))),
  );

  // ── delete_nodes ───────────────────────────────────────────────────────────
  server.registerTool(
    "delete_nodes",
    {
      title: "Delete nodes (one or many, each with its dependent subtree) in one batch",
      description:
        "Remove ONE node or MANY by id in one atomic draft edit — each together with its dependent subtree (its hasChild/hasPart descendants) and every edge touching any removed node. The cascade is computed over ALL the ids at once, so a child shared by two nodes you delete together also vanishes. The dry-run diff shows the FULL set that will vanish and emits a WARNING listing it; nothing is deleted until you confirm, so seeing the cascade before confirming IS the safety (there is no separate force flag). ALL-OR-NOTHING: any missing id (or an id listed twice) blocks the whole batch. The result is re-checked for referential integrity. " +
        "`returnMode` (default 'summary') controls the response: 'summary' returns `counts` {nodesAdded,edgesAdded,nodesChanged,nodesRemoved,edgesRemoved} instead of the full diff (a big cascade's full diff can be large); 'full' also attaches the whole `diff`. " +
        "`idempotencyKey` (optional): a unique key (a UUID) makes a RETRIED confirm safe — same key + same payload replays the first apply's summary with `replayed:true` instead of REPLAY; same key + different payload is rejected as IDEMPOTENCY_KEY_MISMATCH. Namespace-scoped, 24h TTL. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        nodeIds: z.array(z.string()),
        returnMode: z.enum(["summary", "full"]).optional(),
        idempotencyKey: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: {
      nodeIds: string[]; confirm?: boolean; confirmationToken?: string; returnMode?: ReturnMode; idempotencyKey?: string;
    }) => asJson(await runDeleteNodes(a))),
  );
}
