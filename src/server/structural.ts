/*
 * Module: server · tool group: raw graph primitives
 *
 * The low-level edge/node verbs — create_edge, delete_edges, delete_nodes.
 * Node CREATION is the typed authoring tools (server/authoring.ts); these are
 * the escape hatch for edges the typed adds don't set (usesRoutine,
 * buildsTowards, relatesTo, hasDependency, an extra hasEducationalAlignment) and
 * for deletions. All share the pattern:
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
import { runGraphMutation, kgNamespace, linkNodes, unlinkNodes, deleteNode } from "../kg-store/index.js";

function activeNamespace(): string {
  const a = getActiveAdapter();
  return kgNamespace(activeWorkspace(), a.grade, a.subject);
}

// The active adapter's coverage hook as a callback for the framework, so a
// structural edit's dry-run surfaces completeness warnings. [] when none.
function activeCoverage(): (graph: import("../kg-store/index.js").MutationGraph) => string[] {
  const a = getActiveAdapter();
  return (graph) => a.coverageWarnings?.(graph) ?? [];
}

const JsonValue = z.any();

export function registerStructuralTools(server: McpServer) {
  // ── create_edge ──────────────────────────────────────────────────────────
  server.registerTool(
    "create_edge",
    {
      title: "Create an edge between two nodes",
      description:
        "Add an edge of `edgeType` from `fromId` to `toId`. Both endpoints must already exist in the draft. This is the escape hatch for edges the typed add tools don't set for you — `usesRoutine` (apply a routine to a Lesson/Course/Activity), `buildsTowards` / `relatesTo` / `hasDependency` (standard or content prerequisites), or an extra `hasEducationalAlignment`. Edge id is deterministic — the same (type, from, to) triple always produces the same id, and re-creating the same triple is rejected as a duplicate. Edge-type legality across labels is a judgment for the reviewer at publish, not enforced here. REQUIRES CONFIRMATION: dry-run returns diff + confirmationToken; call again with confirm:true and the token to stage the edit on the draft.",
      inputSchema: {
        edgeType: z.string(),
        fromId: z.string(),
        toId: z.string(),
        properties: z.record(JsonValue).optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { edgeType: string; fromId: string; toId: string; properties?: Record<string, unknown>; confirm?: boolean; confirmationToken?: string }) => {
      const namespace = activeNamespace();
      const result = await runGraphMutation({
        namespace,
        mutation: linkNodes,
        args: { edgeType: a.edgeType, fromId: a.fromId, toId: a.toId, properties: a.properties ?? {}, namespace },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: activeCoverage(),
      });
      return asJson(result);
    }),
  );

  // ── delete_edges ───────────────────────────────────────────────────────────
  server.registerTool(
    "delete_edges",
    {
      title: "Delete an edge",
      description:
        "Remove one edge by its `edgeId`. Edge ids are deterministic (`edgeId = <type>:<from>-><to>`) — get one from a prior create_edge preview, from diff_draft, or from the graph. Removing an edge cannot orphan a node (the node just becomes less connected); the dangling-edge check only cares about surviving edges. Use this to detach a node before delete_nodes if you want to keep the (now-detached) subtree. REQUIRES CONFIRMATION.",
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
        coverage: activeCoverage(),
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
        coverage: activeCoverage(),
      });
      return asJson(result);
    }),
  );
}
