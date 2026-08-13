/*
 * Module: server · tool group: curriculum recipes
 *
 * The four GENERIC curriculum verbs — add_node, move_node, reposition,
 * set_content — each a SINGLE two-phase mutation exposed as an MCP tool. They
 * share the exact envelope every graph edit uses (two-phase confirm, the #13
 * referential-integrity floor on the whole result, #7 audit, #8 role gate); what
 * makes them "recipes" is that ONE confirm applies a whole composite atomically
 * to the draft.
 *
 * Unlike the old recipes there is NO RecipeProfile and NO per-subject
 * availability: the verbs are subject-agnostic (they speak pure canonical LC and
 * derive a created node's identity from the graph — see kg-recipes/lc.ts), so
 * they are available on EVERY subject. Validity is structural, enforced by each
 * verb's own `validate` + the shared integrity rules.
 *
 * id-minting mirrors create_node: add_node mints the id server-side on the
 * dry-run and surfaces it at the response top level; the caller passes the SAME
 * id back on confirm so the framework's args-hash matches.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { runGraphMutation, kgNamespace, mintNodeId, type MutationGraph } from "../kg-store/index.js";
import { addNode, moveNode, reposition, setContent } from "../kg-recipes/index.js";
import type { SubjectAdapter } from "../types.js";

// The namespace + coverage hook the active subject binds to. Every recipe tool
// calls this first. No profile to resolve — the verbs are generic.
function bind(adapter: SubjectAdapter): { namespace: string; coverage: (g: MutationGraph) => string[] } {
  return {
    namespace: kgNamespace(activeWorkspace(), adapter.grade, adapter.subject),
    coverage: (g) => adapter.coverageWarnings?.(g as never) ?? [],
  };
}

// On a dry-run preview, surface the minted id at the top level so Claude can pass
// it back on confirm without fishing it out of the diff. No-op on confirm and on
// blocked/unauthorized results.
function withMinted(result: unknown, minted: Record<string, unknown>): unknown {
  const r = result as { kind?: string; phase?: string };
  if (r && r.kind === "graphMutation" && r.phase === "preview") return { ...(result as object), ...minted };
  return result;
}

export function registerRecipeTools(server: McpServer) {
  // ── add_node ────────────────────────────────────────────────────────────────
  server.registerTool(
    "add_node",
    {
      title: "Add a node to the curriculum graph",
      description:
        "GENERIC composite recipe: create ONE node with an LC `label` and attach it under `parentId` via the canonical containment edge (hasPart for content — LessonGrouping/Lesson/Activity/Material; hasChild for standards), at a `position` (defaults to appending), in ONE atomic draft edit. Optionally `alignTo` a StandardsFrameworkItem (hasEducationalAlignment). The node's LC identity (labels, normalized type, role, ordinal path) is DERIVED FROM THE GRAPH — copied from an existing node of that label, or canonical LC defaults if none exists yet. `title` is its display name; `properties` is a free bag of extra canonical LC props written under raw.* (content, materialType, studentGroupingType, timeRequired, educationalUse, groupName…). Referential integrity BLOCKS a nonexistent parent or alignTo. REQUIRES CONFIRMATION: dry-run returns one whole-composite diff + confirmationToken + mintedNodeId; ask the user, then call again with confirm:true, the token, AND the same mintedNodeId. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        parentId: z.string(),
        label: z.string(),
        title: z.string().optional(),
        title_en: z.string().optional(),
        position: z.number().optional(),
        via: z.string().optional(),
        alignTo: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        mintedNodeId: z.string().optional(),   // required on confirm
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { parentId: string; label: string; title?: string; title_en?: string; position?: number; via?: string; alignTo?: string; properties?: Record<string, unknown>; mintedNodeId?: string; confirm?: boolean; confirmationToken?: string }) => {
      const { namespace, coverage } = bind(getActiveAdapter());
      const newNodeId = a.confirm ? (a.mintedNodeId ?? "") : mintNodeId();
      const result = await runGraphMutation({
        namespace,
        mutation: addNode,
        args: { namespace, parentId: a.parentId, label: a.label, newNodeId, title: a.title, title_en: a.title_en, position: a.position, via: a.via, alignTo: a.alignTo, properties: a.properties },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage,
      });
      return asJson(a.confirm ? result : withMinted(result, { mintedNodeId: newNodeId }));
    }),
  );

  // ── move_node ─────────────────────────────────────────────────────────────
  server.registerTool(
    "move_node",
    {
      title: "Move a node to another parent",
      description:
        "GENERIC composite recipe: re-parent a node within the containment tree along one axis — detach its current parent edge, attach `toParentId`, and set its position — in ONE atomic draft edit. The axis is the node's canonical containment edge (override with `via`); a node's second axis (e.g. a lesson also scheduled under a week) is left untouched. Referential integrity validates the whole result. `position` sets the within-target order (defaults to appending). REQUIRES CONFIRMATION. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        nodeId: z.string(),
        toParentId: z.string(),
        via: z.string().optional(),
        position: z.number().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { nodeId: string; toParentId: string; via?: string; position?: number; confirm?: boolean; confirmationToken?: string }) => {
      const { namespace, coverage } = bind(getActiveAdapter());
      const result = await runGraphMutation({
        namespace,
        mutation: moveNode,
        args: { namespace, nodeId: a.nodeId, toParentId: a.toParentId, via: a.via, position: a.position },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage,
      });
      return asJson(result);
    }),
  );

  // ── reposition ──────────────────────────────────────────────────────────────
  server.registerTool(
    "reposition",
    {
      title: "Set a node's position",
      description:
        "GENERIC composite recipe: set a node's `position` — its ordinal among its siblings — in ONE atomic draft edit. Membership is the containment edge, so this NEVER cascades; it is a single-node ordinal edit (the old renumber's chapter→lessons cascade is gone with the join key). REQUIRES CONFIRMATION. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        nodeId: z.string(),
        position: z.number(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { nodeId: string; position: number; confirm?: boolean; confirmationToken?: string }) => {
      const { namespace, coverage } = bind(getActiveAdapter());
      const result = await runGraphMutation({
        namespace,
        mutation: reposition,
        args: { namespace, nodeId: a.nodeId, position: a.position },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage,
      });
      return asJson(result);
    }),
  );

  // ── set_content ─────────────────────────────────────────────────────────────
  server.registerTool(
    "set_content",
    {
      title: "Replace a node's content",
      description:
        "GENERIC composite recipe: replace a node's load-bearing `content` (canonical LC Material.content) in ONE atomic draft edit — the dedicated verb for editing content, since upsert_property is wording-only and cannot reach it. A nonexistent `nodeId` is BLOCKED; to remove content entirely, delete the node instead. REQUIRES CONFIRMATION. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        nodeId: z.string(),
        content: z.string(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { nodeId: string; content: string; confirm?: boolean; confirmationToken?: string }) => {
      const { namespace, coverage } = bind(getActiveAdapter());
      const result = await runGraphMutation({
        namespace,
        mutation: setContent,
        args: { namespace, nodeId: a.nodeId, content: a.content },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage,
      });
      return asJson(result);
    }),
  );
}
