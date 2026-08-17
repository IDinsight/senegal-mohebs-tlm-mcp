/*
 * Module: server · tool group: graph reads (walk + stats)
 *
 * The two generic, subject-agnostic graph readers:
 *   • walk_graph — one directional, filtered, paginated BFS from any node. The
 *     single traversal primitive that replaced get_course: a course subtree is
 *     walk "out" over hasPart/hasChild; the whole standards spine is walk "out"
 *     over hasChild from the framework root; the framework root itself is walk
 *     "in" over hasChild from any standard. slot:"draft" walks the UNPUBLISHED
 *     draft (curator/approver only, same tier as diff_draft) so a curator can
 *     inspect staged edits before publishing.
 *   • namespace_stats — a cheap, argument-free orientation snapshot (node/edge
 *     counts, roots, draft state) to run before writing any query.
 *
 * Both are read-only and scoped to the active workspace/grade/subject.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { getKgStore, kgNamespace, toAuditActor, diffGraphs, type GraphDiff } from "../kg-store/index.js";
import { exportSubtree } from "../kg-export.js";
import { walkGraph, computeGraphStats, type WalkDirection } from "../curriculum/index.js";
import { resolveDraftModel } from "./preview.js";
import { authorize } from "../authz.js";
import { currentActor } from "../actor.js";
import type { CurriculumModel } from "../types.js";

function activeNamespace(): string {
  const adapter = getActiveAdapter();
  return kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);
}

type WalkSlot = "published" | "draft";

// Draft reads are pre-publish working state, gated to the same tier as
// diff_draft / preview_generation (curator + approver). Returns a denial payload
// when blocked — and audits it, so an unauthorized draft peek is recorded — or
// null when allowed. Mirrors preview.ts's own denyIfNotDraftReader.
async function denyIfNotDraftReader(namespace: string): Promise<Record<string, unknown> | null> {
  const actor = currentActor();
  const authz = authorize(actor, "readDraft", namespace);
  if (authz.ok) {
    return null;
  }
  await getKgStore().appendAudit({
    id: randomUUID(),
    ts: new Date().toISOString(),
    actor: toAuditActor(actor),
    namespace,
    eventType: "blocked",
    reason: `unauthorized: ${authz.reason}`,
  });
  return { phase: "unauthorized", action: "readDraft", reason: authz.reason };
}

// Resolve the model to walk: the published read model, or — for slot:"draft" —
// the draft-resolved model diff_draft/preview read from. Returns a notice
// payload (denial, or "no draft") instead of a model when the draft can't be read.
async function resolveWalkModel(
  namespace: string,
  slot: WalkSlot,
): Promise<{ model: CurriculumModel } | { notice: Record<string, unknown> }> {
  if (slot === "published") {
    return { model: getActiveAdapter().model() };
  }

  const denied = await denyIfNotDraftReader(namespace);
  if (denied) {
    return { notice: denied };
  }

  const resolved = await resolveDraftModel(namespace);
  if (!resolved) {
    return {
      notice: {
        slot: "draft",
        noDraft: true,
        message: `No draft exists for '${namespace}' to walk. Stage an edit first (add_node / add_nodes / …), or walk slot:"published".`,
      },
    };
  }
  return { model: resolved.model };
}

// The arguments walk_graph accepts, shared by the tool handler and the exported
// core so tests drive the real logic (slot resolution + gating included).
export type WalkToolArgs = {
  fromId: string;
  direction: WalkDirection;
  edgeTypes?: string[];
  nodeTypes?: string[];
  maxDepth?: number;
  includeEdges?: boolean;
  limit?: number;
  cursor?: string;
  slot?: WalkSlot;
};

// ── Core: walk_graph ──────────────────────────────────────────────────────────
// Resolve the slot (published, or a role-gated draft), then run the generic BFS.
// Exported so tests drive the real logic directly (like buildCapabilitiesReport).
export async function walkActiveGraph(args: WalkToolArgs): Promise<Record<string, unknown>> {
  const namespace = activeNamespace();
  const slot = args.slot ?? "published";

  const resolved = await resolveWalkModel(namespace, slot);
  if ("notice" in resolved) {
    return resolved.notice;
  }

  const result = walkGraph(resolved.model, {
    fromId: args.fromId,
    direction: args.direction,
    edgeTypes: args.edgeTypes,
    nodeTypes: args.nodeTypes,
    maxDepth: args.maxDepth,
    includeEdges: args.includeEdges,
    limit: args.limit,
    cursor: args.cursor,
  });
  return { slot, ...result };
}

// ── Core: namespace_stats ─────────────────────────────────────────────────────
// Exported so tests drive the real logic directly (like buildCapabilitiesReport).
export async function namespaceStats(): Promise<Record<string, unknown>> {
  const adapter = getActiveAdapter();
  const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);
  const stats = computeGraphStats(adapter.model());
  const draft = await draftState(namespace);

  // "no draft open" is the one flag that needs live draft state; the rest are
  // the model-derived structural hints. Orientation only — never authoritative.
  const draftFlags = draft.open ? [] : ["no draft open"];
  const coverageFlags = [...draftFlags, ...stats.structuralFlags];

  // `roots` is capped for orientation (interesting kinds first); `rootsTotal` is
  // the true count, and a note fires when the tail was dropped so the caller knows
  // to walk_graph for the rest rather than assume `roots` is exhaustive.
  const rootsNote = stats.rootsTotal > stats.roots.length
    ? `Showing ${stats.roots.length} of ${stats.rootsTotal} roots (interesting kinds first); the rest are leaf nodes with no containment parent. Walk the graph for specific nodes.`
    : undefined;

  return {
    namespace,
    nodeCounts: stats.nodeCounts,
    edgeCounts: stats.edgeCounts,
    roots: stats.roots,
    rootsTotal: stats.rootsTotal,
    ...(rootsNote ? { rootsNote } : {}),
    draft,
    coverageFlags,
  };
}

// ── Core: export_graph_view ────────────────────────────────────────────────────
// Export a scoped, self-contained slice of the published graph (the containment
// subtree of `fromId`) in the explorer's DisplayGraph shape, so a caller can
// render it as an interactive visualization artifact. Read-only, published slot
// only; exportSubtree self-bounds the payload to stay under the response cap.
// Exported so tests drive the real logic directly (like walkActiveGraph).
export async function exportGraphView(args: { fromId: string; maxDepth?: number; detail?: boolean }): Promise<Record<string, unknown>> {
  const namespace = activeNamespace();
  const result = await exportSubtree(namespace, args.fromId, { maxDepth: args.maxDepth, detail: args.detail });
  if (result === null) {
    return { error: `No published graph for '${namespace}'. The namespace has never been seeded/published.` };
  }
  return result as unknown as Record<string, unknown>;
}

// Live draft state: whether a draft is open and, if so, how many nodes/edges it
// changes vs published (a cheap diff over two small slots, no traversal).
async function draftState(namespace: string): Promise<{ open: boolean; editsStaged?: number }> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer || !pointer.draftSlot) {
    return { open: false };
  }

  const draftSlot = pointer.draftSlot;
  const publishedSlot = pointer.publishedSlot;
  const [draftNodes, draftEdges, publishedNodes, publishedEdges] = await Promise.all([
    store.listNodes(namespace, draftSlot),
    store.listEdges(namespace, draftSlot),
    store.listNodes(namespace, publishedSlot),
    store.listEdges(namespace, publishedSlot),
  ]);

  const diff = diffGraphs(
    { nodes: publishedNodes, edges: publishedEdges },
    { nodes: draftNodes, edges: draftEdges },
  );
  return { open: true, editsStaged: countDiff(diff) };
}

const countDiff = (diff: GraphDiff): number => {
  const nodeChanges = diff.nodes.added.length + diff.nodes.removed.length + diff.nodes.changed.length;
  const edgeChanges = diff.edges.added.length + diff.edges.removed.length + diff.edges.changed.length;
  return nodeChanges + edgeChanges;
};

export function registerGraphTools(server: McpServer) {
  server.registerTool(
    "walk_graph",
    {
      title: "Walk the graph from a node",
      description:
        "Paginated BFS over the active subject's graph. DEFAULT AND EXPECTED USAGE: limit:50, includeEdges:false, narrow nodeTypes. Page via `cursor` until nextCursor is null. Do NOT raise `limit` to fit a big result — that is the single most common misuse and it will overflow the client. `direction:'both'` with empty `nodeTypes` reaches the whole graph and is almost never what you want; narrow first.\n" +
        "  CORRECT:   walk_graph(fromId=<domainId>, direction='out',\n" +
        "             edgeTypes=['hasChild'], nodeTypes=['StandardsFrameworkItem'],\n" +
        "             limit=50)  →  page with cursor until nextCursor is null\n" +
        "  BROKEN:    walk_graph(fromId=<domainId>, direction='both', limit=500,\n" +
        "             includeEdges=true)  →  one page overflows the client\n" +
        "Each response carries `nextCursor` (null on the last page) plus three independent flags: `truncatedByLimit:true` means more matching nodes remain on further pages (call again with `cursor: <nextCursor>`); `truncated:true` means the `maxDepth` cap hid deeper nodes (raise maxDepth to reach them); and `truncatedBySize:true` means the page was trimmed to fit a response BYTE budget, so it holds fewer nodes than `limit` — raising `limit` will NOT help, so instead set includeEdges:false and narrow `nodeTypes`, then page via cursor (the `hint` field spells this out). " +
        "This is the single generic read for every 'list / find / enumerate / traverse' need. `direction`: 'out' follows edges from→to (a Course down to its parts), 'in' follows to→from (a standard up to its framework root), 'both' either. `edgeTypes` filters which edges to follow (empty ⇒ all); `nodeTypes` filters which nodes to RETURN (empty ⇒ all) — non-matching nodes are still traversed THROUGH, so filters compose. `maxDepth` (default 3, max 10) bounds the hops. `includeEdges` (default true) returns the traversed edges so you can rebuild the subgraph. `limit` maxes at 500. `slot`: 'published' (default) reads the live graph; 'draft' reads UNPUBLISHED staged edits (curators/approvers only). Read-only. " +
        "Examples: framework root → walk(fromId=<any standard>, direction='in', edgeTypes=['hasChild'], nodeTypes=['StandardsFramework']); the whole SFI spine → walk(fromId=<root>, direction='out', edgeTypes=['hasChild'], nodeTypes=['StandardsFrameworkItem']), then keep calling with cursor:<nextCursor> until nextCursor is null; a course subtree → walk(fromId=<courseId>, direction='out', edgeTypes=['hasPart','hasChild']).",
      inputSchema: {
        fromId: z.string(),
        direction: z.enum(["out", "in", "both"]),
        edgeTypes: z.array(z.string()).optional(),
        nodeTypes: z.array(z.string()).optional(),
        maxDepth: z.number().int().optional(),
        includeEdges: z.boolean().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
        slot: z.enum(["published", "draft"]).optional(),
      },
    },
    guarded(async (a: WalkToolArgs) => asJson(await walkActiveGraph(a))),
  );

  server.registerTool(
    "namespace_stats",
    {
      title: "Namespace orientation snapshot",
      description:
        "A cheap, argument-free snapshot of the active workspace/grade/subject: `nodeCounts` (per LC label), `edgeCounts` (per edge type), `roots` (nodes with no inbound containment edge — Course/StandardsFramework/orphan groupings, each with id + labels + description), `draft` (whether one is open and how many edits it stages), and `coverageFlags` (high-level orientation hints). Run this FIRST, before writing any walk_graph query, to see the shape of the graph — and this is where you find the subject's Course content roots (id + name) to walk from (it replaced list_courses; filter `roots` by labels including 'Course'). Read-only; no audit event.",
      inputSchema: {},
    },
    guarded(async () => asJson(await namespaceStats())),
  );

  server.registerTool(
    "export_graph_view",
    {
      title: "Export a scoped graph slice for a visualization artifact",
      description:
        "Returns a SELF-CONTAINED slice of the active subject's published graph — the containment subtree rooted at `fromId` — in the explorer's DisplayGraph shape (`nodes`, `edges`, `meta.taxonomy` legend, `meta.viewConfig`, `meta.counts`). Feed this JSON into a self-contained HTML artifact to render the same interactive tree the live KG explorer shows (nodes coloured by LC label; folded hasChild containment with Standards / Curriculum / Progression / By-type views). " +
        "Scope it to ONE thing: get a root id from namespace_stats (a Course/chapter) or walk_graph, then export its subtree. `maxDepth` (default 4, max 12) bounds how deep the subtree goes. `detail` (default false) includes each node's full raw LC property bag (the detail-panel data); leave it off for a compact payload and turn it on only for a small subtree. " +
        "The payload is self-bounded to fit the response cap: an oversized detailed slice auto-drops `detail`, and a slice that is still too big returns `{ tooLarge, counts, message }` telling you to lower maxDepth, pick a deeper root, or use the live explorer for the whole graph. Read-only, published slot only (no draft). This returns DATA; render the visual from it.",
      inputSchema: {
        fromId: z.string(),
        maxDepth: z.number().int().optional(),
        detail: z.boolean().optional(),
      },
    },
    guarded(async (a: { fromId: string; maxDepth?: number; detail?: boolean }) => asJson(await exportGraphView(a))),
  );
}
