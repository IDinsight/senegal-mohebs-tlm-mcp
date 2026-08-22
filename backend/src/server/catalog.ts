/*
 * Module: server · tool group: catalog
 *
 * Tools over the reusable-spec catalog. The catalog spans TWO scopes, both read
 * here: the cross-tenant SHARED library and the active workspace's own library.
 *   - list_catalog  — browse the entries a curator can pick, from BOTH scopes,
 *                     each tagged with its scope + kind (read-only, ungated).
 *   - use_routine   — COPY a routine entry onto a lesson (linked via `usesRoutine`).
 *   - use_formatter — COPY a formatter entry (a house-style spec) under a document.
 *                     Both share one path: the entry's subtree is cloned with fresh
 *                     ids into the ACTIVE subject's draft; the copy is independent of
 *                     the library. They diverge in the ATTACHMENT — a routine links to
 *                     a Lesson via `usesRoutine`; a formatter is relabelled to the
 *                     document layer (Formatter/FormatterSpec) and hung under the
 *                     Course's TeachingLearningMaterial via `hasPart`.
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
import { getKgStore, mintNodeId, runGraphMutation, kgNamespace, publishDraft, discardDraft, type MutationGraph, type MutationEdge, type MutationNode, type StoredEdge, type StoredNode } from "../kg-store/index.js";
import { SHARED_CATALOG_NAMESPACE, catalogNamespace, cloneRoutineSubtree, relabelClonedFormatter, addCatalogEntry, listCatalogEntries, renderCatalogEntry, useRoutine, useFormatter, type CatalogScope, type UseRoutineArgs, type UseFormatterArgs } from "../kg-recipes/index.js";
import { parkWrapperContext, readWrapperContext, deleteWrapperContext } from "./wrapper-park.js";
// Destination resolution moved to catalog-target.ts, which the generic write
// verbs (edit_node / add_nodes / create_edges) share for their `catalog` redirect.
import { resolveCatalogTarget } from "./catalog-target.js";

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
// entry across both scopes, clone its subtree into the active subject, and attach the
// clone. Two-phase (mints an id-map on dry-run, reuses it on confirm). The two tools
// diverge in the ATTACHMENT, keyed by `mode`:
//   - "routine"   — the clone is copied verbatim and linked to a Lesson via `usesRoutine`;
//   - "formatter" — the clone is relabelled to the document layer (Formatter/
//     FormatterSpec) and hung under the Course's TeachingLearningMaterial via `hasPart`.
// The token-only confirm path reads the mode back from the parked context, so a
// confirm dispatches to the right mutation without the caller re-stating it.
type CatalogApplyMode = "routine" | "formatter";
type ApplyArgs = { entryId?: string; targetId?: string; mintedIdMap?: Record<string, string>; confirm?: boolean; confirmationToken?: string };
// The wrapper's parked context for a use_routine / use_formatter confirm: the mode,
// the cloned subtree's mutation args the dry-run built, plus the id-map to surface in
// the response. Discriminated by `mode` so the confirm runs the matching mutation.
type ParkedApplyContext =
  | { mode: "routine"; mutationArgs: UseRoutineArgs; idMap: Record<string, string> }
  | { mode: "formatter"; mutationArgs: UseFormatterArgs; idMap: Record<string, string> };

// Resolve the TeachingLearningMaterial a formatter attaches under, from the id the
// caller gave use_formatter. A TLM id is used directly; a Course id resolves to the
// TLM that `covers` it (the document produced from that Course). Reads the active
// graph DRAFT-first so a just-authored TLM resolves. Any other node — or a Course
// with no TLM yet — is an actionable error: a formatter is a property of the
// DOCUMENT (TLM ─hasPart→ Formatter), never the curriculum.
async function resolveFormatterTarget(namespace: string, targetId: string): Promise<{ tlmId: string } | { error: string }> {
  const graph = await readActiveGraph(namespace);
  const target = graph.nodes.find((n) => n.id === targetId);
  if (!target) return { error: `Target '${targetId}' does not exist in the active graph.` };
  const labels = target.labels ?? [];
  if (labels.includes("TeachingLearningMaterial")) return { tlmId: targetId };
  if (labels.includes("Course")) {
    const tlmId = graph.nodes.find(
      (n) => (n.labels ?? []).includes("TeachingLearningMaterial") && graph.edges.some((e) => e.type === "covers" && e.from === n.id && e.to === targetId),
    )?.id;
    if (tlmId) return { tlmId };
    return { error: `Course '${targetId}' has no TeachingLearningMaterial covering it yet. A formatter attaches under the DOCUMENT, not the Course — mint a TeachingLearningMaterial that \`covers\` this Course (add_nodes + create_edges), then use_formatter against the Course or the TLM directly.` };
  }
  return { error: `'${targetId}' is a ${labels.join("/") || "node"} — use_formatter targets a TeachingLearningMaterial (the document), or a Course to resolve its TLM.` };
}

// Shared tail for a dry-run / confirm: on a dry-run park the built context (so a large
// clone can be confirmed token-only) and surface the id-map; on a confirm return the
// mutation result verbatim. `idMap` and the parked context differ per mode.
async function finishApply(namespace: string, result: Awaited<ReturnType<typeof runGraphMutation>>, idMap: Record<string, string>, confirm: boolean | undefined, parked: ParkedApplyContext) {
  let payloadStored = false;
  if (!confirm && result.phase === "preview") {
    payloadStored = await parkWrapperContext<ParkedApplyContext>(namespace, result.confirmationToken, parked);
  }
  if (confirm) return asJson(result);
  const preview = withMintedMap(result, idMap) as Record<string, unknown>;
  return asJson({ ...preview, payloadStored });
}

export async function applyCatalogEntry(a: ApplyArgs, mode: CatalogApplyMode = "routine") {
  const adapter = getActiveAdapter();
  const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

  // Token-only confirm shortcut: caller sends confirm+token with no entryId /
  // targetId / mintedIdMap. Read back the cloned subtree the dry-run parked and
  // apply that verbatim — the args-hash still matches because they are the exact
  // args the token was minted from. The parked mode picks the mutation.
  if (a.confirm && !a.entryId) {
    const parked = a.confirmationToken ? await readWrapperContext<ParkedApplyContext>(namespace, a.confirmationToken) : null;
    if (!parked) return asJson({ phase: "apply", ok: false, reason: "stale", message: "The previewed catalog application has expired or was already used; re-run without confirm to preview again." });
    const result = parked.mode === "formatter"
      ? await runGraphMutation({ namespace, mutation: useFormatter, args: parked.mutationArgs, confirm: true, token: a.confirmationToken })
      : await runGraphMutation({ namespace, mutation: useRoutine, args: parked.mutationArgs, confirm: true, token: a.confirmationToken });
    if (result.phase === "apply" && result.ok && a.confirmationToken) await deleteWrapperContext(namespace, a.confirmationToken);
    return asJson(result);
  }

  if (!a.entryId || !a.targetId) return asJson({ error: "entryId and targetId are required on a dry-run." });

  const catalogs = await Promise.all(catalogScopes().map((s) => readCatalog(s.namespace)));
  const source = catalogs.find((graph) => graph.nodes.some((n) => n.id === a.entryId));
  if (!source) return asJson({ error: `Catalog entry '${a.entryId}' not found in the shared or workspace library. Call list_catalog for entry ids.` });

  const mint = a.confirm ? (oldId: string) => (a.mintedIdMap ?? {})[oldId] : () => mintNodeId();

  if (mode === "formatter") {
    // A formatter hangs under the document (TLM), not the Course — resolve the TLM
    // first, then relabel the clone to the Formatter/FormatterSpec document shape.
    const resolved = await resolveFormatterTarget(namespace, a.targetId);
    if ("error" in resolved) return asJson({ error: resolved.error });
    const clone = relabelClonedFormatter(cloneRoutineSubtree(source, a.entryId, namespace, mint)!);
    const mutationArgs: UseFormatterArgs = { namespace, tlmId: resolved.tlmId, clonedNodes: clone.nodes, clonedEdges: clone.edges, newFormatterId: clone.newEntryId };
    const result = await runGraphMutation({ namespace, mutation: useFormatter, args: mutationArgs, confirm: a.confirm, token: a.confirmationToken });
    return finishApply(namespace, result, clone.idMap, a.confirm, { mode: "formatter", mutationArgs, idMap: clone.idMap });
  }

  const clone = cloneRoutineSubtree(source, a.entryId, namespace, mint)!;
  const mutationArgs: UseRoutineArgs = { namespace, targetId: a.targetId, clonedNodes: clone.nodes, clonedEdges: clone.edges, newEntryId: clone.newEntryId };
  const result = await runGraphMutation({ namespace, mutation: useRoutine, args: mutationArgs, confirm: a.confirm, token: a.confirmationToken });
  return finishApply(namespace, result, clone.idMap, a.confirm, { mode: "routine", mutationArgs, idMap: clone.idMap });
}

// ── add_to_catalog: file an authored routine/formatter INTO a catalog ─────────
// The write inverse of use_routine. use_routine copies a library entry OUT onto a
// lesson; this copies one IN — a routine/formatter subtree authored in the active
// subject graph, cloned (fresh ids) into a catalog library and PUBLISHED in one
// gated step (catalogs aren't enterable contexts, so there is no separate
// publish_draft for them). Destination rights ride the catalog's namespace: the
// shared library (_shared) needs super_admin; a workspace library that tenant's curators.

// Read a namespace's current graph, preferring its DRAFT slot so a just-authored
// (still-unpublished) routine is visible — the natural flow is author inline (a
// draft edit) then add it to the catalog. Falls back to published; empty when unseeded.
async function readActiveGraph(namespace: string): Promise<MutationGraph> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer) return { nodes: [], edges: [] };
  const slot = pointer.draftSlot ?? pointer.publishedSlot;
  const [nodes, edges] = await Promise.all([store.listNodes(namespace, slot), store.listEdges(namespace, slot)]);
  const dropSlot = <T extends { slot: unknown }>(x: T): Omit<T, "slot"> => { const { slot: _s, ...rest } = x; return rest; };
  return { nodes: nodes.map((n: StoredNode) => dropSlot(n) as MutationNode), edges: edges.map((e: StoredEdge) => dropSlot(e) as MutationEdge) };
}

// Tag a dry-run preview so the caller knows confirming PUBLISHES the library live
// (not merely stages a draft, as the graph tools do) and where it lands.
function withCatalogPublishNote(result: unknown, target: { scope: CatalogScope; workspace: string; namespace: string }): unknown {
  const r = result as { phase?: string };
  if (!r || r.phase !== "preview") return result;
  return {
    ...(result as object),
    publishesOnConfirm: true,
    destination: { scope: target.scope, workspace: target.workspace, namespace: target.namespace },
    note: `Confirming does NOT just stage a draft — it PUBLISHES this entry live into the ${target.scope} catalog ('${target.namespace}') in one step. Confirm the destination with the user before proceeding.`,
  };
}

type AddToCatalogArgs = {
  entryId?: string;
  targetWorkspace?: string;
  mintedIdMap?: Record<string, string>;
  confirm?: boolean;
  confirmationToken?: string;
};

// Parked context for a token-only add_to_catalog confirm. The whole apply-and-
// publish sequence needs to run against the catalog namespace, not the active
// subject — so we park that namespace + the target metadata alongside the
// mutation args, and reconstruct the response's `scope/workspace/namespace/entryId`
// without touching activeWorkspace() (which may have moved).
type ParkedAddToCatalogContext = {
  target: { scope: CatalogScope; workspace: string; namespace: string };
  mutationArgs: { namespace: string; clonedNodes: MutationNode[]; clonedEdges: MutationEdge[]; newEntryId: string };
  idMap: Record<string, string>;
};

// Exported so tests drive the real logic (like runAddNodes / runPublishDraft).
// Returns the raw result record; the tool registration wraps it in asJson.
export async function runAddToCatalog(a: AddToCatalogArgs): Promise<Record<string, unknown>> {
  // Token-only confirm shortcut: caller sends confirm+token with no entryId /
  // targetWorkspace / mintedIdMap. Read back the parked context and run the
  // apply-and-publish against the SAME catalog namespace it was previewed against.
  if (a.confirm && !a.entryId) {
    // We don't know the catalog namespace until we read the parked entry, but
    // wrapper-park is keyed by (namespace, nonce). We keyed the dry-run park by
    // the CATALOG namespace, so probe both possible catalog namespaces (the
    // shared library and the active workspace's) — whichever holds the entry.
    const candidateNss = catalogScopes().map((s) => s.namespace);
    let parked: ParkedAddToCatalogContext | null = null;
    for (const ns of candidateNss) {
      parked = a.confirmationToken ? await readWrapperContext<ParkedAddToCatalogContext>(ns, a.confirmationToken) : null;
      if (parked) break;
    }
    if (!parked) return { phase: "apply", ok: false, reason: "stale", message: "The previewed add_to_catalog has expired or was already used; re-run without confirm to preview again." };

    const catalogNs = parked.target.namespace;
    const applied = await runGraphMutation({ namespace: catalogNs, mutation: addCatalogEntry, args: parked.mutationArgs, confirm: true, token: a.confirmationToken });
    if (applied.phase !== "apply" || !(applied as { ok?: boolean }).ok) return applied as unknown as Record<string, unknown>;
    const published = await publishDraft(catalogNs);
    if (!published.ok) {
      await discardDraft(catalogNs).catch(() => undefined);
      return { error: `Entry staged but publishing the ${parked.target.scope} catalog was refused: ${published.reason}. The catalog draft was rolled back — nothing changed.` };
    }
    if (a.confirmationToken) await deleteWrapperContext(catalogNs, a.confirmationToken);
    return { ok: true, published: true, scope: parked.target.scope, workspace: parked.target.workspace, namespace: catalogNs, entryId: parked.mutationArgs.newEntryId, auditId: published.auditId };
  }

  const target = await resolveCatalogTarget(a.targetWorkspace);
  if (target.kind === "error") return { error: target.message };
  if (target.kind === "choose") {
    return {
      needsChoice: true,
      message: "You are a super admin — choose which catalog to add this entry to, then call add_to_catalog again with `targetWorkspace` set to one of the `target` values below.",
      choices: target.choices,
    };
  }

  const catalogNs = target.namespace;
  // The catalog must already exist (a root container to file under). Bootstrapping a
  // brand-new library is a seed-time job (scripts/seed-catalog.mjs), not this tool's.
  const pointer = await getKgStore().readPointer(catalogNs);
  if (!pointer) return { error: `The ${target.scope} catalog ('${catalogNs}') has not been seeded yet — seed it before adding entries.` };

  if (!a.entryId) return { error: "entryId is required on a dry-run." };

  // Source: the entry authored in the ACTIVE subject graph (draft-preferred).
  const adapter = getActiveAdapter();
  const activeNs = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);
  const source = await readActiveGraph(activeNs);

  // Clone its subtree into the catalog with fresh ids (stable across dry-run/confirm
  // via the echoed id-map), exactly like use_routine's copy — but toward the library.
  const mint = a.confirm ? (oldId: string) => (a.mintedIdMap ?? {})[oldId] : () => mintNodeId();
  const clone = cloneRoutineSubtree(source, a.entryId, catalogNs, mint);
  if (!clone) return { error: `Entry '${a.entryId}' was not found in the active graph. Author it first (add_nodes: an InstructionalRoutine + its steps/materials), then add it to the catalog.` };

  const mutationArgs = { namespace: catalogNs, clonedNodes: clone.nodes, clonedEdges: clone.edges, newEntryId: clone.newEntryId };

  // Dry-run: stage nothing; return the diff + the id-map to echo back + the publish note.
  if (!a.confirm) {
    const preview = await runGraphMutation({ namespace: catalogNs, mutation: addCatalogEntry, args: mutationArgs });
    let payloadStored = false;
    if (preview.phase === "preview") {
      payloadStored = await parkWrapperContext<ParkedAddToCatalogContext>(catalogNs, preview.confirmationToken, {
        target: { scope: target.scope, workspace: target.workspace, namespace: target.namespace },
        mutationArgs, idMap: clone.idMap,
      });
    }
    const shaped = withCatalogPublishNote(withMintedMap(preview, clone.idMap), target) as Record<string, unknown>;
    return { ...shaped, payloadStored };
  }

  // Confirm: apply to the catalog's draft…
  const applied = await runGraphMutation({ namespace: catalogNs, mutation: addCatalogEntry, args: mutationArgs, confirm: true, token: a.confirmationToken });
  if (applied.phase !== "apply" || !(applied as { ok?: boolean }).ok) return applied as unknown as Record<string, unknown>; // blocked / unauthorized / failed — nothing to publish

  // …then PUBLISH it live, one gated step. If publish is refused (e.g. strict
  // separation-of-duties), roll the draft back so nothing is stranded in a
  // namespace the curator can't enter to finish or discard.
  const published = await publishDraft(catalogNs);
  if (!published.ok) {
    await discardDraft(catalogNs).catch(() => undefined);
    return { error: `Entry staged but publishing the ${target.scope} catalog was refused: ${published.reason}. The catalog draft was rolled back — nothing changed.` };
  }
  if (a.confirmationToken) await deleteWrapperContext(catalogNs, a.confirmationToken);
  return { ok: true, published: true, scope: target.scope, workspace: target.workspace, namespace: catalogNs, entryId: clone.newEntryId, auditId: published.auditId };
}

// Shared confirm-gate + copy input, declared on both apply tools.
// `entryId` / `targetId` are required on dry-run; on a token-only confirm (large
// clone held server-side) they are omitted alongside `mintedIdMap`.
const APPLY_INPUT = {
  entryId: z.string().optional(),
  targetId: z.string().optional(),
  mintedIdMap: z.record(z.string(), z.string()).optional(),   // required on re-send confirm
  confirm: z.boolean().optional(),
  confirmationToken: z.string().optional(),
};

export function registerCatalogTools(server: McpServer) {
  server.registerTool(
    "list_catalog",
    { title: "List the catalog", description: "Browse the reusable-spec catalog — the instructional routines and formatters a curator can apply to content. Reads BOTH the shared cross-tenant library and the active workspace's own; each entry carries its `scope` (shared | workspace) and `kind` (routine | formatter), plus id, name, cross-cutting summary, ordered steps (name + timing), and material count. Pass a routine's id to use_routine, or a formatter's to use_formatter, to copy it. For an entry's FULL authored spec, call get_catalog_entry. [] when nothing is seeded. EDITING an entry: this is also where the NODE IDS come from, because a catalog cannot be traversed (walk_graph reads the active subject only). `materials[]` on an entry lists its own Material children — a FORMATTER's spec lives there; `steps[i].materials[]` lists a nested step's Material children. Those ids are what `edit_node(nodeId, content, catalog)` takes. A flat routine step carries its text on the step node itself, so `steps[i].id` IS the editable id and its `materials` is empty.", inputSchema: {} },
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
      description: "Read ONE catalog entry's FULL authored spec, as markdown: a routine's summary + its ordered, timed steps AND each step's Material content; a formatter's spec Material. This is the detail list_catalog only COUNTS (materialCount) — the same content the `catalog://` browse resource serves, exposed as a TOOL so it works in every client (not only those with a resource browser). Pass the entry `id` from list_catalog; both libraries (shared + workspace) are searched. Each block of authored text is preceded by the NODE ID holding it (`edit_node nodeId: ...`), so a spec you find wrong here can be corrected straight away with edit_node(nodeId, content, catalog) — a catalog is not walkable, so this is where content and its id appear together. Read-only.",
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
      description: "Apply a catalog ROUTINE to a lesson by COPYING it. The entry (from the shared OR the workspace library) is cloned with fresh ids into the active subject and linked to `targetId` (a Lesson) via `usesRoutine`. The copy is independent — later edits to the library entry do not reach it. REQUIRES CONFIRMATION: dry-run returns diff + confirmationToken + mintedIdMap. When the dry-run reports `payloadStored:true` (a large clone held server-side), confirm with ONLY confirm:true + the token — do NOT re-send entryId/targetId/mintedIdMap; otherwise re-send confirm:true, the token, and the same mintedIdMap. DRAFT edit — publish_draft to make it live.",
      inputSchema: APPLY_INPUT,
    },
    guarded(async (a: ApplyArgs) => applyCatalogEntry(a, "routine")),
  );

  server.registerTool(
    "use_formatter",
    {
      title: "Use a catalog formatter",
      description: "Apply a catalog FORMATTER (a house-style spec) to a DOCUMENT by COPYING it. `targetId` is a TeachingLearningMaterial (the document node), OR a Course — in which case the TLM that `covers` that Course is resolved for you. The entry (from the shared OR the workspace library) is cloned with fresh ids into the active subject, RELABELLED to the document layer (Formatter + FormatterSpec), and hung under the TLM via `hasPart`, so generating that document applies the style. Formatting is a property of the document, not the curriculum — it never rides a Course's usesRoutine edge. (If a Course has no TLM yet, mint one first: add_nodes a TeachingLearningMaterial + create_edges a `covers` edge to the Course.) The copy is independent — later edits to the library formatter do not reach it. REQUIRES CONFIRMATION: dry-run returns diff + confirmationToken + mintedIdMap. When the dry-run reports `payloadStored:true` (a large clone held server-side), confirm with ONLY confirm:true + the token — do NOT re-send entryId/targetId/mintedIdMap; otherwise re-send confirm:true, the token, and the same mintedIdMap. DRAFT edit — publish_draft to make it live.",
      inputSchema: APPLY_INPUT,
    },
    guarded(async (a: ApplyArgs) => applyCatalogEntry(a, "formatter")),
  );

  server.registerTool(
    "add_to_catalog",
    {
      title: "Add a routine or formatter to the catalog",
      description: "Publish a routine or formatter you AUTHORED (an InstructionalRoutine entry + its steps/materials, built in the active subject with add_nodes) INTO a catalog library, so list_catalog / use_routine / use_formatter can then reuse it. It clones the entry's whole subtree with fresh ids into the destination and files it under that library's root — the write inverse of use_routine. DESTINATION: a workspace curator adds to their OWN workspace's library (omit targetWorkspace). A super_admin may target the shared cross-tenant library OR any workspace — pass `targetWorkspace` ('_shared' for the shared library, or a workspace id); call WITHOUT it to get back the list of catalogs to choose from. GATED by the destination — because it PUBLISHES, it needs an APPROVER of that workspace (or super_admin for the shared library). TWO-PHASE, and confirming does BOTH in one step: the dry-run returns the diff + confirmationToken + mintedIdMap. When the dry-run reports `payloadStored:true` (a large clone held server-side), confirm with ONLY confirm:true + the token — do NOT re-send entryId/targetWorkspace/mintedIdMap; otherwise re-send confirm:true + the token + the same mintedIdMap. Catalogs aren't enterable contexts, so there is no separate publish_draft.",
      inputSchema: {
        entryId: z.string().optional(),   // required on dry-run; omitted on token-only confirm
        targetWorkspace: z.string().optional(),
        mintedIdMap: z.record(z.string(), z.string()).optional(),   // required on re-send confirm
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: AddToCatalogArgs) => asJson(await runAddToCatalog(a))),
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
      description: "Reusable instructional routines and formatters (shared + workspace libraries), each rendered with its full authored spec. Browse-only; apply one to content with use_routine (→ a Lesson, via usesRoutine) or use_formatter (→ a document / TeachingLearningMaterial, via hasPart).",
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
