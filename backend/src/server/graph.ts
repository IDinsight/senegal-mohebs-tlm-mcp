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
import { activeWorkspace, sessionState } from "../context/index.js";
import { getKgStore, kgNamespace, toAuditActor, diffGraphs, type GraphDiff } from "../kg-store/index.js";
import { exportSubtree } from "../kg-export.js";
import { walkGraph, computeGraphStats, documentSubgraph, documentSectionSubgraph, lessonSubgraph, PRELOADED_SLOT_KEY, type WalkDirection } from "../curriculum/index.js";
import { resolveDraftModel } from "./preview.js";
import { authorize } from "../authz.js";
import { currentActor } from "../actor.js";
import type { CurriculumModel } from "../types.js";

function activeNamespace(): string {
  const adapter = getActiveAdapter();
  return kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);
}

// The physical slot ("a"/"b") the session's published read model was hydrated
// from — stamped by activate.ts / refreshActiveContext. It is the true origin of
// a slot:"published" read, so reporting it lets a caller spot a read/write
// disagreement (e.g. reads still on the old slot after a publish flip). null
// before any context is activated.
function preloadedSlot(): string | null {
  return (sessionState().bag.get(PRELOADED_SLOT_KEY) as string | undefined) ?? null;
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
): Promise<{ model: CurriculumModel; physicalSlot: string | null } | { notice: Record<string, unknown> }> {
  if (slot === "published") {
    return { model: getActiveAdapter().model(), physicalSlot: preloadedSlot() };
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
  // resolveDraftModel read the pointer fresh, so draftSlot is the real slot.
  return { model: resolved.model, physicalSlot: resolved.draftSlot };
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
  return { slot, physicalSlot: resolved.physicalSlot, ...result };
}

// ── Core: walk_document ───────────────────────────────────────────────────────
// Resolve one TeachingLearningMaterial's full scope: its assembly guide, its
// rendering stack, and the curriculum it renders (section spine or Course
// fallback). The generation-side counterpart to walk_graph — where walk_graph
// reads the curriculum to teach, this reads the document to produce. Slot-aware
// (published default; role-gated draft) like walk_graph, so a curator can inspect
// a document they are authoring before publishing. Exported so tests drive the
// real logic directly.
export async function walkDocument(args: { tlmId: string; slot?: WalkSlot }): Promise<Record<string, unknown>> {
  const namespace = activeNamespace();
  const slot = args.slot ?? "published";

  const resolved = await resolveWalkModel(namespace, slot);
  if ("notice" in resolved) {
    return resolved.notice;
  }

  const document = documentSubgraph(resolved.model, args.tlmId);
  if (!document) {
    return { error: `TeachingLearningMaterial '${args.tlmId}' not found in the ${slot} graph. Call namespace_stats (its roots, filtered by labels including 'TeachingLearningMaterial') for available document ids.` };
  }
  return { slot, physicalSlot: resolved.physicalSlot, ...document };
}

// ── Core: walk_lesson ─────────────────────────────────────────────────────────
// Resolve one Lesson's full generation scope: its own content subtree, the routine
// that applies to it (its own usesRoutine, else the nearest ancestor's — the Course
// default), and the formatters of every document that covers it. The per-lesson
// counterpart to walk_document: where walk_document reads a whole document, this
// reads a single lesson with its inherited pedagogy + formatting folded in.
// Slot-aware (published default; role-gated draft) like the other walk_* readers.
// Exported so tests drive the real logic directly.
export async function walkLesson(args: { lessonId: string; tlmId?: string; slot?: WalkSlot }): Promise<Record<string, unknown>> {
  const namespace = activeNamespace();
  const slot = args.slot ?? "published";

  const resolved = await resolveWalkModel(namespace, slot);
  if ("notice" in resolved) {
    return resolved.notice;
  }

  const lesson = lessonSubgraph(resolved.model, args.lessonId, args.tlmId);
  if (!lesson) {
    return { error: `Lesson '${args.lessonId}' not found in the ${slot} graph. Call walk_graph (nodeTypes ['Lesson']) from a Course to find lesson ids.` };
  }
  return { slot, physicalSlot: resolved.physicalSlot, ...lesson };
}

// ── Core: walk_document_section ───────────────────────────────────────────────
// Resolve one DocumentSection's full generation scope: the owning document, the
// curriculum this slot renders, the routine that applies (section → document →
// covered-curriculum, nearest-wins), and the formatters (the TLM's doc-wide stack
// plus the section's own). The per-section counterpart to walk_document — the unit
// generation produces a document from, section by section. Slot-aware (published
// default; role-gated draft) like the other walk_* readers. Exported so tests drive
// the real logic directly.
export async function walkDocumentSection(args: { sectionId: string; slot?: WalkSlot }): Promise<Record<string, unknown>> {
  const namespace = activeNamespace();
  const slot = args.slot ?? "published";

  const resolved = await resolveWalkModel(namespace, slot);
  if ("notice" in resolved) {
    return resolved.notice;
  }

  const section = documentSectionSubgraph(resolved.model, args.sectionId);
  if (!section) {
    return { error: `DocumentSection '${args.sectionId}' not found in the ${slot} graph. Call walk_document (its 'sections' spine) or walk_graph (nodeTypes ['DocumentSection']) to find section ids.` };
  }
  return { slot, physicalSlot: resolved.physicalSlot, ...section };
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
    physicalSlot: preloadedSlot(),
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
        "Examples: framework root → walk(fromId=<any standard>, direction='in', edgeTypes=['hasChild'], nodeTypes=['StandardsFramework']); the whole SFI spine → walk(fromId=<root>, direction='out', edgeTypes=['hasChild'], nodeTypes=['StandardsFrameworkItem']), then keep calling with cursor:<nextCursor> until nextCursor is null; a course subtree → walk(fromId=<courseId>, direction='out', edgeTypes=['hasPart','hasChild']). " +
        "Each response also carries `physicalSlot` — the actual slot ('a'/'b') the returned data came from — so you can confirm reads and writes agree after a publish.",
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
    "walk_document",
    {
      title: "Resolve a document's generation scope",
      description:
        "Given a TeachingLearningMaterial (TLM) id — a document/deliverable root, found via namespace_stats roots (filter labels for 'TeachingLearningMaterial') — return everything generation composes to produce that document (docs/design-notes/teaching-learning-materials.md). This is the document-side counterpart to walk_graph: walk_graph reads the curriculum to TEACH, walk_document reads the document to PRODUCE. Returns: `assemblyGuide` (the document's own authored 'how to build me' markdown, from metadata.assemblyGuide, or null); `scope` — how the curriculum was resolved: 'sections' (the TLM has a DocumentSection spine), 'course' (the simple TLM→covers→Course fallback), or 'none' (covers nothing yet); `sections` (the ordered DocumentSection spine, each with its `covers` curriculum targets — an EMPTY covers marks a front-matter section like a cover/TOC); `document` (the TLM subtree as raw nodes+edges — the TLM plus its hasPart Formatter/FormatterSpec rendering stack and DocumentSections, with the covers edges); and `curriculum` (the resolved curriculum-to-render as raw nodes+edges — pure hasPart/hasChild containment, NOT usesRoutine, because formatting reaches generation through the TLM, not the curriculum). Read-only. `slot`: 'published' (default) or 'draft' (UNPUBLISHED staged edits — curators/approvers only), so you can inspect a document you are authoring before publishing.",
      inputSchema: {
        tlmId: z.string(),
        slot: z.enum(["published", "draft"]).optional(),
      },
    },
    guarded(async (a: { tlmId: string; slot?: WalkSlot }) => asJson(await walkDocument(a))),
  );

  server.registerTool(
    "walk_lesson",
    {
      title: "Resolve one lesson's generation scope",
      description:
        "Given a Lesson id, return everything a per-lesson generation composes to produce that single lesson — the per-lesson counterpart to walk_document (which reads a whole document). Find lesson ids with walk_graph (nodeTypes ['Lesson']) from a Course. Returns: `lessonNode` (the lesson's raw fields); `content` (the lesson's own hasPart subtree — Activities/Materials/Assessments — as raw nodes+edges); `routine` (the InstructionalRoutine that APPLIES, resolved nearest-wins: the lesson's own usesRoutine if it has one, else inherited from the nearest containment ancestor — typically the Course carrying one default routine for every lesson — with `resolvedFrom` (the node that carried the edge), `inherited` (false when the lesson carries it directly), and the routine subtree; null when nothing in the lesson's ancestry uses a routine); and `formatters` (one entry per document that covers this lesson — a TLM whose covers reaches the lesson directly or via its Course — each with the TLM id, the covered node `via`, and its Formatter/FormatterSpec rendering stack). Pass `tlmId` to scope the formatters to a single document you are generating (omit for every covering document). This is the reader that folds inherited pedagogy + formatting into a lesson; the Course/document readers stay pure containment. Read-only. `slot`: 'published' (default) or 'draft' (UNPUBLISHED staged edits — curators/approvers only).",
      inputSchema: {
        lessonId: z.string(),
        tlmId: z.string().optional(),
        slot: z.enum(["published", "draft"]).optional(),
      },
    },
    guarded(async (a: { lessonId: string; tlmId?: string; slot?: WalkSlot }) => asJson(await walkLesson(a))),
  );

  server.registerTool(
    "walk_document_section",
    {
      title: "Resolve one document section's generation scope",
      description:
        "Given a DocumentSection id, return everything a per-section generation composes to produce that ONE slot of a document — the unit a `.docx` is produced from, section by section (docs/design-notes/walk-document-section.md). Find section ids in walk_document's `sections` spine, or via walk_graph (nodeTypes ['DocumentSection']). This is the document-first counterpart to walk_lesson: a DocumentSection already IS the document↔curriculum binding (it hangs under exactly one TLM and `covers` its curriculum node), so nothing is reverse-searched — its document scope, routine, and formatters are all unambiguous. Returns: `section` (the DocumentSection's raw fields — its position + any per-section assemblyGuide); `document` (the owning TLM: its id, assemblyGuide, and raw node carrying audience/mediumType — null if the section is not under a TLM yet); `covers` (the curriculum node id(s) this section renders — an EMPTY array marks a front-matter section like a cover/TOC/intro); `curriculum` (the covered subtree as raw nodes+edges — pure hasPart/hasChild containment from the covers targets); `routine` (the InstructionalRoutine that APPLIES, resolved nearest-wins along a document-first chain: the section's own usesRoutine, else the owning TLM's, else the nearest routine up the covered curriculum's ancestry — with `resolvedFrom`, `resolvedFromScope` ('section'|'document'|'curriculum'), and the routine subtree; null when nothing in the chain uses a routine); and `formatters` (the owning TLM's DOC-WIDE Formatter/FormatterSpec stack unioned with this section's own per-section stack, as raw nodes+edges — sibling sections' stacks excluded). Read-only. `slot`: 'published' (default) or 'draft' (UNPUBLISHED staged edits — curators/approvers only).",
      inputSchema: {
        sectionId: z.string(),
        slot: z.enum(["published", "draft"]).optional(),
      },
    },
    guarded(async (a: { sectionId: string; slot?: WalkSlot }) => asJson(await walkDocumentSection(a))),
  );

  server.registerTool(
    "namespace_stats",
    {
      title: "Namespace orientation snapshot",
      description:
        "A cheap, argument-free snapshot of the active workspace/grade/subject: `nodeCounts` (per LC label), `edgeCounts` (per edge type), `roots` (nodes with no inbound containment edge — Course/StandardsFramework/orphan groupings, each with id + labels + description), `draft` (whether one is open and how many edits it stages), and `coverageFlags` (high-level orientation hints). Run this FIRST, before writing any walk_graph query, to see the shape of the graph — and this is where you find the subject's Course content roots (id + name) to walk from (it replaced list_courses; filter `roots` by labels including 'Course'). Also carries `physicalSlot` — the slot ('a'/'b') these counts were read from. Read-only; no audit event.",
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
