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

  return {
    namespace,
    nodeCounts: stats.nodeCounts,
    edgeCounts: stats.edgeCounts,
    roots: stats.roots,
    draft,
    coverageFlags,
  };
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
        "Traverse the active subject's graph from `fromId` by breadth-first search, following only the edge types you name and returning only the node labels you want — the single generic read for every 'list / find / enumerate / traverse' need. `direction`: 'out' follows edges from→to (a Course down to its parts), 'in' follows to→from (a standard up to its framework root), 'both' either. `edgeTypes` filters which edges to follow (empty ⇒ all); `nodeTypes` filters which nodes to RETURN (empty ⇒ all) — non-matching nodes are still traversed THROUGH, so filters compose. `maxDepth` (default 3, max 10) bounds the hops. `includeEdges` (default true) returns the traversed edges so you can rebuild the subgraph. " +
        "PAGINATION IS THE EXPECTED PATH: `limit` defaults to 50 (max 500) — do NOT raise the limit to fit a big result; instead page. Each response carries `nextCursor` (null on the last page) plus two independent flags: `truncatedByLimit:true` means more matching nodes remain on further pages (call again with `cursor: <nextCursor>`), while `truncated:true` means the `maxDepth` cap hid deeper nodes (raise maxDepth to reach them). `slot`: 'published' (default) reads the live graph; 'draft' reads UNPUBLISHED staged edits (curators/approvers only). Read-only. " +
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
}
