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
import { runGraphMutation, kgNamespace, unlinkNodes, deleteNode } from "../kg-store/index.js";
import { createEdges } from "../kg-recipes/index.js";
import { runBatchMutation, type ReturnMode } from "./batch.js";
import { idempotencyPayloadHash } from "./idempotency.js";

function activeNamespace(): string {
  const a = getActiveAdapter();
  return kgNamespace(activeWorkspace(), a.grade, a.subject);
}

const JsonValue = z.any();

// The create_edges core, exported so tests drive the real logic. Normalizes each
// edge's properties, then delegates response shaping + idempotency to
// runBatchMutation (no minted ids for edges, so `extra` is empty).
export async function runCreateEdges(a: {
  edges: Array<{ edgeType: string; fromId: string; toId: string; properties?: Record<string, unknown> }>;
  confirm?: boolean;
  confirmationToken?: string;
  returnMode?: ReturnMode;
  idempotencyKey?: string;
}): Promise<Record<string, unknown>> {
  const namespace = activeNamespace();
  const normalizedEdges = a.edges.map((edge) => ({ ...edge, properties: edge.properties ?? {} }));
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
  });
}

export function registerStructuralTools(server: McpServer) {
  // ── create_edges ───────────────────────────────────────────────────────────
  server.registerTool(
    "create_edges",
    {
      title: "Create edges (one or many) in one batch",
      description:
        "The edge-creation tool — add ONE edge or MANY in one atomic draft edit (it replaced the single create_edge). Use it for edges add_nodes doesn't set: `usesRoutine` (apply a routine to a Lesson/Course/Activity), `buildsTowards` / `relatesTo` / `hasDependency` (prerequisites), or an extra `hasEducationalAlignment`. Each `edges[i]` has `edgeType`, `fromId`, `toId`, and optional `properties`; both endpoints must already exist in the draft (ids minted by a prior committed add_nodes are valid). Edge ids are deterministic (`<type>:<from>-><to>`); a duplicate triple is rejected — duplicate detection spans BOTH the batch and the current draft. ALL-OR-NOTHING: the dry-run validates every edge and returns ONE confirmationToken; any item error blocks the whole batch (no partial apply). To confirm, call again with confirm:true and the token. Edge-type legality across labels is a reviewer judgment at publish, not enforced here. " +
        "`returnMode` (default 'summary') controls the response: 'summary' returns `counts` {nodesAdded,edgesAdded,nodesChanged,nodesRemoved,edgesRemoved} instead of the full diff; 'full' also attaches the whole `diff`. " +
        "`idempotencyKey` (optional): a unique key (a UUID) makes a RETRIED confirm safe — same key + same payload replays the first apply's summary with `replayed:true` (no double-apply/audit) instead of REPLAY; same key + different payload is rejected as IDEMPOTENCY_KEY_MISMATCH. Namespace-scoped, 24h TTL. Omit for strict single-use. DRAFT edit.",
      inputSchema: {
        edges: z.array(
          z.object({
            edgeType: z.string(),
            fromId: z.string(),
            toId: z.string(),
            properties: z.record(JsonValue).optional(),
          }),
        ),
        returnMode: z.enum(["summary", "full"]).optional(),
        idempotencyKey: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: {
      edges: Array<{ edgeType: string; fromId: string; toId: string; properties?: Record<string, unknown> }>;
      confirm?: boolean; confirmationToken?: string; returnMode?: ReturnMode; idempotencyKey?: string;
    }) => asJson(await runCreateEdges(a))),
  );

  // ── delete_edges ───────────────────────────────────────────────────────────
  server.registerTool(
    "delete_edges",
    {
      title: "Delete an edge",
      description:
        "Remove one edge by its `edgeId`. Edge ids are deterministic (`edgeId = <type>:<from>-><to>`) — get one from a prior create_edges preview, from diff_draft, or from the graph. Removing an edge cannot orphan a node (the node just becomes less connected); the dangling-edge check only cares about surviving edges. Use this to detach a node before delete_nodes if you want to keep the (now-detached) subtree. REQUIRES CONFIRMATION.",
      inputSchema: {
        edgeId: z.string(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { edgeId: string; confirm?: boolean; confirmationToken?: string }) => {
      const namespace = activeNamespace();
      const result = await runGraphMutation({
        namespace,
        mutation: unlinkNodes,
        args: { edgeId: a.edgeId },
        confirm: a.confirm,
        token: a.confirmationToken,
      });
      return asJson(result);
    }),
  );

  // ── delete_nodes ───────────────────────────────────────────────────────────
  server.registerTool(
    "delete_nodes",
    {
      title: "Delete a node (and its dependent subtree)",
      description:
        "Remove one node by `nodeId`, together with its dependent subtree (its hasChild/hasPart descendants) and every edge touching any removed node — all in ONE atomic mutation. The dry-run diff shows the FULL set that will vanish and emits a WARNING listing it; nothing is deleted until you confirm, so seeing the cascade before confirming IS the safety (there is no separate force flag). The result is re-checked for referential integrity. A node deleted here is gone from the DRAFT; publish_draft makes it live. REQUIRES CONFIRMATION.",
      inputSchema: {
        nodeId: z.string(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { nodeId: string; confirm?: boolean; confirmationToken?: string }) => {
      const namespace = activeNamespace();
      const result = await runGraphMutation({
        namespace,
        mutation: deleteNode,
        args: { nodeId: a.nodeId },
        confirm: a.confirm,
        token: a.confirmationToken,
      });
      return asJson(result);
    }),
  );
}
