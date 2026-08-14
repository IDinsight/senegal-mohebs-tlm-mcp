/*
 * Module: server · tool group: routine catalog
 *
 * Two tools over the shared routine catalog (a reserved namespace, CATALOG_NAMESPACE,
 * read the same by every context):
 *   - list_catalog  — browse the entries a curator can pick (read-only, ungated).
 *   - use_routine   — COPY a catalog entry onto a lesson. The entry's whole subtree
 *                     is cloned with fresh ids into the ACTIVE subject's draft and
 *                     linked via `usesRoutine`; the copy is independent of the library.
 *
 * use_routine shares the graph-mutation envelope: a dry-run returns a diff +
 * confirmationToken + the minted id-map (no state change); the confirm re-checks the
 * token and applies to the DRAFT only. Because the copy mints many ids, the dry-run
 * surfaces the whole `old → new` map (as add_node surfaces its single mintedNodeId),
 * and the caller passes it back on confirm so both phases build the identical clone.
 *
 * See docs/design-notes/authorable-catalog.md.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { getKgStore, mintNodeId, runGraphMutation, kgNamespace, type MutationGraph, type MutationEdge, type MutationNode, type StoredEdge, type StoredNode } from "../kg-store/index.js";
import { CATALOG_NAMESPACE, cloneRoutineSubtree, listCatalogEntries, useRoutine } from "../kg-recipes/index.js";

// Read the shared catalog's published slot as a plain MutationGraph. Empty when the
// catalog namespace has never been seeded (no pointer) — list_catalog then returns [].
// Exported for tests (the seed→read→clone path); the tools call it internally.
export async function readCatalogGraph(): Promise<MutationGraph> {
  const store = getKgStore();
  const pointer = await store.readPointer(CATALOG_NAMESPACE);
  if (!pointer) return { nodes: [], edges: [] };
  const [nodes, edges] = await Promise.all([
    store.listNodes(CATALOG_NAMESPACE, pointer.publishedSlot),
    store.listEdges(CATALOG_NAMESPACE, pointer.publishedSlot),
  ]);
  const dropSlot = <T extends { slot: unknown }>(x: T): Omit<T, "slot"> => { const { slot, ...rest } = x; return rest; };
  return { nodes: nodes.map((n: StoredNode) => dropSlot(n) as MutationNode), edges: edges.map((e: StoredEdge) => dropSlot(e) as MutationEdge) };
}

// Surface the id-map at the top level of a dry-run preview so the caller passes it
// back on confirm (mirrors authoring.ts::withMinted, one id → many).
function withMintedMap(result: unknown, mintedIdMap: Record<string, string>): unknown {
  const r = result as { kind?: string; phase?: string };
  if (r && r.kind === "graphMutation" && r.phase === "preview") return { ...(result as object), mintedIdMap };
  return result;
}

export function registerCatalogTools(server: McpServer) {
  server.registerTool(
    "list_catalog",
    { title: "List the routine catalog", description: "Browse the shared routine catalog — the reusable instructional routines a curator can apply to a lesson. Returns each entry's id, name, cross-cutting summary, ordered steps (name + timing), and material count. Pass an entry id to use_routine to copy it onto a lesson. [] when the catalog has not been seeded.", inputSchema: {} },
    guarded(async () => {
      const catalog = await readCatalogGraph();
      return asJson({ namespace: CATALOG_NAMESPACE, entries: listCatalogEntries(catalog) });
    }),
  );

  server.registerTool(
    "use_routine",
    {
      title: "Use a catalog routine",
      description: "Apply a catalog routine to a lesson by COPYING it. The entry's subtree (steps + Materials) is cloned with fresh ids into the active subject and linked to `targetId` (a Lesson/Course/Activity) via `usesRoutine`. The copy is independent — later edits to the library entry do not reach it. REQUIRES CONFIRMATION: dry-run returns diff + confirmationToken + mintedIdMap; call again with confirm:true, the token, and the same mintedIdMap. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        entryId: z.string(),
        targetId: z.string(),
        mintedIdMap: z.record(z.string(), z.string()).optional(),   // required on confirm
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { entryId: string; targetId: string; mintedIdMap?: Record<string, string>; confirm?: boolean; confirmationToken?: string }) => {
      const adapter = getActiveAdapter();
      const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);
      const coverage = (g: MutationGraph) => adapter.coverageWarnings?.(g as never) ?? [];

      const catalog = await readCatalogGraph();
      const mint = a.confirm ? (oldId: string) => (a.mintedIdMap ?? {})[oldId] : () => mintNodeId();
      const clone = cloneRoutineSubtree(catalog, a.entryId, namespace, mint);
      if (!clone) return asJson({ error: `Catalog entry '${a.entryId}' not found. Call list_catalog for entry ids.` });

      const result = await runGraphMutation({
        namespace,
        mutation: useRoutine,
        args: { namespace, targetId: a.targetId, clonedNodes: clone.nodes, clonedEdges: clone.edges, newEntryId: clone.newEntryId },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage,
      });
      return asJson(a.confirm ? result : withMintedMap(result, clone.idMap));
    }),
  );
}
