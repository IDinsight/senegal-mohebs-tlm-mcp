/*
 * Module: server · tool group: catalog
 *
 * Tools over the reusable-spec catalog. The catalog spans TWO scopes, both read
 * here: the cross-tenant SHARED library and the active workspace's own library.
 *   - list_catalog  — browse the entries a curator can pick, from BOTH scopes,
 *                     each tagged with its scope + kind (read-only, ungated).
 *   - use_routine   — COPY a routine entry onto a lesson.
 *   - use_formatter — COPY a formatter entry (a house-style spec) onto a Course.
 *                     Both share one path: the entry's subtree is cloned with fresh
 *                     ids into the ACTIVE subject's draft and linked via `usesRoutine`;
 *                     the copy is independent of the library.
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
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, asMarkdown, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { getKgStore, mintNodeId, runGraphMutation, kgNamespace, type MutationGraph, type MutationEdge, type MutationNode, type StoredEdge, type StoredNode } from "../kg-store/index.js";
import { SHARED_CATALOG_NAMESPACE, catalogNamespace, cloneRoutineSubtree, listCatalogEntries, renderCatalogEntry, useRoutine, type CatalogScope } from "../kg-recipes/index.js";

// Read one catalog namespace's published slot as a plain MutationGraph. Empty when
// that namespace has never been seeded (no pointer). Exported for tests.
export async function readCatalog(namespace: string): Promise<MutationGraph> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer) return { nodes: [], edges: [] };
  const [nodes, edges] = await Promise.all([
    store.listNodes(namespace, pointer.publishedSlot),
    store.listEdges(namespace, pointer.publishedSlot),
  ]);
  const dropSlot = <T extends { slot: unknown }>(x: T): Omit<T, "slot"> => { const { slot, ...rest } = x; return rest; };
  return { nodes: nodes.map((n: StoredNode) => dropSlot(n) as MutationNode), edges: edges.map((e: StoredEdge) => dropSlot(e) as MutationEdge) };
}

// The catalog scopes visible in the active context: the shared library plus the
// active workspace's own (the workspace scope is dropped when the active workspace
// IS the shared one — there is only one library then).
function catalogScopes(): Array<{ scope: CatalogScope; namespace: string }> {
  const scopes: Array<{ scope: CatalogScope; namespace: string }> = [{ scope: "shared", namespace: SHARED_CATALOG_NAMESPACE }];
  const workspaceNs = catalogNamespace(activeWorkspace());
  if (workspaceNs !== SHARED_CATALOG_NAMESPACE) scopes.push({ scope: "workspace", namespace: workspaceNs });
  return scopes;
}

// Surface the id-map at the top level of a dry-run preview so the caller passes it
// back on confirm (mirrors authoring.ts::withMinted, one id → many).
function withMintedMap(result: unknown, mintedIdMap: Record<string, string>): unknown {
  const r = result as { kind?: string; phase?: string };
  if (r && r.kind === "graphMutation" && r.phase === "preview") return { ...(result as object), mintedIdMap };
  return result;
}

// The shared copy-onto-target path behind use_routine and use_formatter: locate the
// entry across both scopes, clone its subtree into the active subject, and link the
// clone to `targetId` via `usesRoutine`. Two-phase (mints an id-map on dry-run, reuses
// it on confirm). The two tools differ only in intent/wording — a routine attaches to
// a Lesson, a formatter to the Course/deliverable — but the mechanism is identical.
type ApplyArgs = { entryId: string; targetId: string; mintedIdMap?: Record<string, string>; confirm?: boolean; confirmationToken?: string };
async function applyCatalogEntry(a: ApplyArgs) {
  const adapter = getActiveAdapter();
  const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

  const catalogs = await Promise.all(catalogScopes().map((s) => readCatalog(s.namespace)));
  const source = catalogs.find((graph) => graph.nodes.some((n) => n.id === a.entryId));
  if (!source) return asJson({ error: `Catalog entry '${a.entryId}' not found in the shared or workspace library. Call list_catalog for entry ids.` });

  const mint = a.confirm ? (oldId: string) => (a.mintedIdMap ?? {})[oldId] : () => mintNodeId();
  const clone = cloneRoutineSubtree(source, a.entryId, namespace, mint)!;

  const result = await runGraphMutation({
    namespace,
    mutation: useRoutine,
    args: { namespace, targetId: a.targetId, clonedNodes: clone.nodes, clonedEdges: clone.edges, newEntryId: clone.newEntryId },
    confirm: a.confirm,
    token: a.confirmationToken,
  });
  return asJson(a.confirm ? result : withMintedMap(result, clone.idMap));
}

// Shared confirm-gate + copy input, declared on both apply tools.
const APPLY_INPUT = {
  entryId: z.string(),
  targetId: z.string(),
  mintedIdMap: z.record(z.string(), z.string()).optional(),   // required on confirm
  confirm: z.boolean().optional(),
  confirmationToken: z.string().optional(),
};

export function registerCatalogTools(server: McpServer) {
  server.registerTool(
    "list_catalog",
    { title: "List the catalog", description: "Browse the reusable-spec catalog — the instructional routines and formatters a curator can apply to content. Reads BOTH the shared cross-tenant library and the active workspace's own; each entry carries its `scope` (shared | workspace) and `kind` (routine | formatter), plus id, name, cross-cutting summary, ordered steps (name + timing), and material count. Pass a routine's id to use_routine, or a formatter's to use_formatter, to copy it. For an entry's FULL authored spec, call get_catalog_entry. [] when nothing is seeded.", inputSchema: {} },
    guarded(async () => {
      const scopes = catalogScopes();
      const perScope = await Promise.all(scopes.map(async (s) => listCatalogEntries(await readCatalog(s.namespace), s.scope)));
      return asJson({ scopes: scopes.map((s) => ({ scope: s.scope, namespace: s.namespace })), entries: perScope.flat() });
    }),
  );

  server.registerTool(
    "get_catalog_entry",
    {
      title: "Read a catalog entry",
      description: "Read ONE catalog entry's FULL authored spec, as markdown: a routine's summary + its ordered, timed steps AND each step's Material content; a formatter's spec Material. This is the detail list_catalog only COUNTS (materialCount) — the same content the `catalog://` browse resource serves, exposed as a TOOL so it works in every client (not only those with a resource browser). Pass the entry `id` from list_catalog; both libraries (shared + workspace) are searched. Read-only.",
      inputSchema: { id: z.string() },
    },
    guarded(async (a: { id: string }) => {
      for (const s of catalogScopes()) {
        const markdown = renderCatalogEntry(await readCatalog(s.namespace), a.id, s.scope);
        // The entry's authored spec IS markdown — return it tagged text/markdown
        // (labelled by scope + id) so it renders, not as an escaped JSON string.
        if (markdown) return asMarkdown(`catalog://${s.scope}/${a.id}`, markdown);
      }
      return asJson({ error: `Catalog entry '${a.id}' not found in the shared or workspace library. Call list_catalog for entry ids.` });
    }),
  );

  server.registerTool(
    "use_routine",
    {
      title: "Use a catalog routine",
      description: "Apply a catalog ROUTINE to a lesson by COPYING it. The entry (from the shared OR the workspace library) is cloned with fresh ids into the active subject and linked to `targetId` (a Lesson) via `usesRoutine`. The copy is independent — later edits to the library entry do not reach it. REQUIRES CONFIRMATION: dry-run returns diff + confirmationToken + mintedIdMap; call again with confirm:true, the token, and the same mintedIdMap. DRAFT edit — publish_draft to make it live.",
      inputSchema: APPLY_INPUT,
    },
    guarded(async (a: ApplyArgs) => applyCatalogEntry(a)),
  );

  server.registerTool(
    "use_formatter",
    {
      title: "Use a catalog formatter",
      description: "Apply a catalog FORMATTER (a house-style spec) to a Course by COPYING it. The entry (from the shared OR the workspace library) is cloned with fresh ids into the active subject and linked to `targetId` (the Course — the root of the document it produces) via `usesRoutine`, so generation for that Course applies the style. The copy is independent — later edits to the library formatter do not reach it. REQUIRES CONFIRMATION: dry-run returns diff + confirmationToken + mintedIdMap; call again with confirm:true, the token, and the same mintedIdMap. DRAFT edit — publish_draft to make it live.",
      inputSchema: APPLY_INPUT,
    },
    guarded(async (a: ApplyArgs) => applyCatalogEntry(a)),
  );
}

// The catalog scopes to browse, tolerant of no active context: the shared library
// is always readable; the workspace library is added only when a context is set
// (resources may be listed before set_context, when activeWorkspace() would throw).
function catalogScopesSafe(): Array<{ scope: CatalogScope; namespace: string }> {
  const scopes: Array<{ scope: CatalogScope; namespace: string }> = [{ scope: "shared", namespace: SHARED_CATALOG_NAMESPACE }];
  try {
    const ws = catalogNamespace(activeWorkspace());
    if (ws !== SHARED_CATALOG_NAMESPACE) scopes.push({ scope: "workspace", namespace: ws });
  } catch { /* no active workspace → shared library only */ }
  return scopes;
}

const firstLine = (s: string): string => { const i = s.indexOf("\n"); return (i === -1 ? s : s.slice(0, i)).trim(); };

// Browse surface (D5): expose each catalog entry as a readable MCP RESOURCE
// (`catalog://{scope}/{id}`), rendered with its FULL authored spec — the step /
// formatter Material content that list_catalog only counts. Resources are
// read-only and ungated (browsing a shared/own library reveals no tenant data);
// applying an entry still goes through the confirm-gated use_routine / use_formatter.
export function registerCatalogResources(server: McpServer) {
  server.registerResource(
    "catalog-entry",
    new ResourceTemplate("catalog://{scope}/{id}", {
      list: async () => {
        const scopes = catalogScopesSafe();
        const perScope = await Promise.all(scopes.map(async (s) => listCatalogEntries(await readCatalog(s.namespace), s.scope)));
        return {
          resources: perScope.flat().map((e) => ({
            uri: `catalog://${e.scope}/${e.id}`,
            name: e.name || e.id,
            title: e.name || e.id,
            mimeType: "text/markdown",
            description: `${e.kind} · ${e.scope} · ${e.steps.length} step(s), ${e.materialCount} material(s)${e.summary ? ` — ${firstLine(e.summary)}` : ""}`,
          })),
        };
      },
    }),
    {
      title: "Catalog entries",
      description: "Reusable instructional routines and formatters (shared + workspace libraries), each rendered with its full authored spec. Browse-only; apply one to content with use_routine (→ a Lesson) or use_formatter (→ a Course).",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const scope: CatalogScope = String(variables.scope) === "workspace" ? "workspace" : "shared";
      const id = String(variables.id);
      let namespace = SHARED_CATALOG_NAMESPACE;
      if (scope === "workspace") {
        try { namespace = catalogNamespace(activeWorkspace()); }
        catch { return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: "Set a context (set_context) to read a workspace-scoped catalog entry." }] }; }
      }
      const md = renderCatalogEntry(await readCatalog(namespace), id, scope);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: md ?? `Catalog entry '${id}' not found in the ${scope} library.` }] };
    },
  );
}
