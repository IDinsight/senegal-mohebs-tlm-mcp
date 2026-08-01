// ── Module: server · tool group: structural graph edits ─────────────────────
// The four raw structural primitives — create_node, link_nodes, unlink_nodes,
// delete_node. Each is a single #5 mutation exposed as an MCP tool. All share
// the pattern established by upsert_property:
//
//   • Two-phase confirm (dry-run returns diff + confirmationToken; confirm
//     applies to the DRAFT only).
//   • #6's structural rules always fire (id-immutable, no-orphan). Plus a
//     mutation-specific validate — see src/kg-store/structural.ts.
//   • #7 audits every apply and every denial.
//   • #8 gates all four on the curator/approver role.
//
// Deliberately verbs-only in this step:
//   • delete_node REFUSES to remove a node with incident edges — cascade
//     lives in #14. The caller's manual flow is unlink_nodes each incident
//     edge, then delete_node.
//   • No composite / recipe tools (add-chapter, split-chapter) — those live
//     in #13. Multi-primitive sequences still accumulate atomically on the
//     draft and publish together via the existing publish_draft flow.
//   • No structural-property editing of EXISTING nodes (renumber, code
//     change) — separate future step. create_node sets properties at
//     birth; upsert_property remains wording-only.
//
// id-minting for create_node is a TOOL-LAYER concern: the tool generates a
// randomUUID once per dry-run and threads it through as `newNodeId` in the
// mutation args. The framework hashes the args (including the id) into the
// confirmation token, so a confirm can only apply the same dry-run's id.
// The tool response surfaces `mintedNodeId` at the top level so Claude can
// pass it back on confirm. The tool's input schema does NOT declare an
// `id` parameter — a caller cannot supply one; the mutation's validate
// also hard-rejects a caller-supplied `id` in `properties`.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import {
  runGraphMutation,
  kgNamespace,
  createNode,
  linkNodes,
  unlinkNodes,
  deleteNode,
  mintNodeId,
} from "../kg-store/index.js";

// Small helper: namespace for the active grade/subject. Same convention as
// every other tool in this codebase — no explicit namespace argument.
function activeNamespace(): string {
  const a = getActiveAdapter();
  return kgNamespace(a.grade, a.subject);
}

// The active adapter's coverage hook (#13) as a callback for the framework —
// so a structural edit's dry-run surfaces completeness warnings (e.g. "the
// chapter you just emptied has no bilan"). [] when the adapter declares none.
function activeCoverage(): (graph: import("../kg-store/index.js").MutationGraph) => string[] {
  const a = getActiveAdapter();
  return (graph) => a.coverageWarnings?.(graph) ?? [];
}

// A JSON-serializable value — z.record's element type. Kept loose because
// `properties` is subject-specific and no schema layer constrains it.
const JsonValue = z.any();

export function registerStructuralTools(server: McpServer) {
  // ── create_node ─────────────────────────────────────────────────────────
  server.registerTool(
    "create_node",
    {
      title: "Create a new node",
      description:
        "Add a new node to the graph. `kind` must be a node kind already used on this namespace (e.g. chapter/lesson/component/task for CI maths). `properties` sets the wording and other subject-specific fields at BIRTH; missing wording keys surface as WARNINGS (not blocks) so the reviewer can spot incomplete nodes at publish. The node id is MINTED SERVER-SIDE (returned as `mintedNodeId` in the response) — the caller cannot supply an id. REQUIRES CONFIRMATION: called without confirm:true it returns a preview (diff + confirmationToken + mintedNodeId); ask the user, then call again with confirm:true, the token, AND the same mintedNodeId. This is a DRAFT edit — publish_draft to make it live. Structural verbs are non-cascading; linking the new node to the graph is a separate link_nodes call.",
      inputSchema: {
        kind: z.string(),
        properties: z.record(JsonValue).optional(),
        mintedNodeId: z.string().optional(),   // required on confirm; absent on dry-run
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { kind: string; properties?: Record<string, unknown>; mintedNodeId?: string; confirm?: boolean; confirmationToken?: string }) => {
      const adapter = getActiveAdapter();
      const namespace = kgNamespace(adapter.grade, adapter.subject);
      // Dry-run: mint the id here. Confirm: the caller must supply the same
      // minted id from the dry-run response (so the framework's args-hash
      // matches). If they don't, argsMismatch fires cleanly.
      const newNodeId = a.confirm
        ? (a.mintedNodeId ?? "")   // empty string → the mutation's validate errors with a clear message
        : mintNodeId();
      const result = await runGraphMutation({
        namespace,
        mutation: createNode,
        args: {
          kind: a.kind,
          properties: a.properties ?? {},
          namespace,
          aliases: adapter.wordingAliases,
          newNodeId,
        },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: (g) => adapter.coverageWarnings?.(g) ?? [],
      });
      // Surface the minted id at the response top level on dry-run so Claude
      // can pass it back on confirm without having to fish it out of the diff.
      if (!a.confirm && result.kind === "graphMutation" && "phase" in result && result.phase === "preview") {
        return asJson({ ...result, mintedNodeId: newNodeId });
      }
      return asJson(result);
    }),
  );

  // ── link_nodes ─────────────────────────────────────────────────────────
  server.registerTool(
    "link_nodes",
    {
      title: "Link two nodes with an edge",
      description:
        "Add an edge of `edgeType` from `fromId` to `toId`. Both endpoints must already exist in the draft; `edgeType` must be a type already used on this namespace (hasChild / buildsTowards for CI maths). Edge id is deterministic — the same (type, from, to) triple always produces the same id, and re-linking the same triple is rejected as a duplicate. Edge-type LEGALITY across kinds (e.g. does hasChild make sense from a task to a chapter?) is not enforced here — that's a judgment for the reviewer at publish. REQUIRES CONFIRMATION: dry-run returns diff + confirmationToken; call again with confirm:true and the token to stage the edit on the draft.",
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
        args: {
          edgeType: a.edgeType,
          fromId: a.fromId,
          toId: a.toId,
          properties: a.properties ?? {},
          namespace,
        },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: activeCoverage(),
      });
      return asJson(result);
    }),
  );

  // ── unlink_nodes ───────────────────────────────────────────────────────
  server.registerTool(
    "unlink_nodes",
    {
      title: "Remove an edge",
      description:
        "Remove one edge by its `edgeId`. Edge ids are deterministic (`edgeId = <type>:<from>-><to>`) — get one from a prior link_nodes preview, from diff_draft, or from the graph. Removing an edge cannot orphan a node (the node just becomes less connected); Rule 2's dangling-edge check only cares about surviving edges. Use this to detach a node before delete_node (delete_node refuses to remove a node with incident edges — no cascade in this step). REQUIRES CONFIRMATION.",
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

  // ── delete_node ────────────────────────────────────────────────────────
  server.registerTool(
    "delete_node",
    {
      title: "Delete a node",
      description:
        "Remove one node by `nodeId`. By DEFAULT (force:false) it is REFUSED if any edge still points at the node — the validate hook lists the incident edges so you can unlink_nodes each one first, then retry. Pass `force:true` to instead CASCADE-delete the node together with its dependent subtree (its hasChild children, their children, …) and every edge touching any removed node, all in ONE atomic mutation; the dry-run diff shows the FULL set that will vanish, and the result is re-checked for referential integrity. Cascade NEVER happens without explicit force. A node deleted here is gone from the DRAFT; publish_draft makes it live. delete_node followed by create_node with the same content is caught by Rule 1 (id-immutable) as a disguised rename. REQUIRES CONFIRMATION.",
      inputSchema: {
        nodeId: z.string(),
        force: z.boolean().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { nodeId: string; force?: boolean; confirm?: boolean; confirmationToken?: string }) => {
      const namespace = activeNamespace();
      const result = await runGraphMutation({
        namespace,
        mutation: deleteNode,
        args: { nodeId: a.nodeId, force: a.force },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: activeCoverage(),
      });
      return asJson(result);
    }),
  );
}
