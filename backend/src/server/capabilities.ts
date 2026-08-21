/*
 * Module: server · tool group: get_capabilities
 *
 * A read-only mirror of what the current caller can do RIGHT NOW: role,
 * allowed actions, whether a draft exists, what's editable, and the safety
 * rules in force. Never a second source of truth — every field is sourced
 * from the module that ACTUALLY enforces or defines it:
 *
 *   actor.role           ← currentActor()               (from #1's verified JWT)
 *   actions.*            ← authorize(actor, X, ns)      (from #8, the real gate)
 *   draft.exists         ← store.readPointer()           (from #4)
 *   draft.createdBy      ← store.listAudit()             (from #7)
 *   editable.recipes     ← RECIPES                       (the generic edit verbs)
 *   rules.structural     ← STRUCTURAL_RULES              (from #6)
 *
 * Any calculation of "who can do what" done here would be a copy that could
 * drift. The mirror-property test asserts every actions.* value matches
 * what authorize() returns for the same (actor, action, namespace).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { currentActor } from "../actor.js";
import { authorize, effectiveRole, type AuthAction } from "../authz.js";
import {
  kgNamespace, getKgStore, STRUCTURAL_RULES,
} from "../kg-store/index.js";
import { RECIPES, SHARED_CATALOG_NAMESPACE, catalogNamespace } from "../kg-recipes/index.js";
import { KIND_PROPERTIES } from "./authoring.js";

// The five actions this server has today. Kept as a const-tuple so the
// response shape is stable and the mirror-property test can iterate over
// the same set the tool reports.
const CAPABILITY_ACTIONS = [
  "canReadGenerate",  // reads and generation are ungated (no authorize() call needed)
  "canReadDraft",     // #9's diff_draft
  "canPreview",       // preview_generation (draft-resolved) — same tier as readDraft
  "canEditDraft",     // the apply gate for every draft edit (recipes / structural / typed adds)
  "canDiscardDraft",  // #9's discard_draft
  "canPublish",       // #9's publish_draft
  "canReadAudit",     // #16's read_audit — approver-only, same tier as publish
] as const;

// Map each capability action to the underlying authz action name, when
// authorize() is what gates it. `canReadGenerate` has no gate — reads are
// open to unknown actors too.
const CAPABILITY_TO_AUTHZ: Record<Exclude<typeof CAPABILITY_ACTIONS[number], "canReadGenerate">, AuthAction> = {
  canReadDraft: "readDraft",
  canPreview: "readDraft",   // previewing reads the unpublished draft — same trust tier
  canEditDraft: "apply",
  canDiscardDraft: "discard",
  canPublish: "publish",
  canReadAudit: "readAudit",  // reviewing the append-only trail — approver-only
};

// The inner logic, exported so tests can drive it without spinning up an
// McpServer. `registerCapabilityTools` just wraps this in the MCP tool
// envelope.
export async function buildCapabilitiesReport(): Promise<Record<string, unknown>> {
  const adapter = getActiveAdapter();
  const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);
  const actor = currentActor();

  // ── actions: one call per gated action to authorize(). Reads are
  // ungated — always true. Zero role-mapping logic lives here.
  const actions: Record<string, boolean> = {
    canReadGenerate: true,
  };
  for (const [cap, authAction] of Object.entries(CAPABILITY_TO_AUTHZ)) {
    actions[cap] = authorize(actor, authAction, namespace).ok;
  }

  // ── draft: pointer says exists/not. If it exists, the most recent
  // createDraft audit record names its creator (from #7).
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  const draftExists = !!pointer?.draftSlot;
  let createdBy: { id: string; email: string | null; role: string | null; ts: string } | undefined;
  if (draftExists) {
    const [mostRecentCreate] = await store.listAudit({ namespace, eventType: "createDraft", limit: 1 });
    if (mostRecentCreate) {
      createdBy = {
        id: mostRecentCreate.actor.id,
        email: mostRecentCreate.actor.email,
        role: mostRecentCreate.actor.role,
        ts: mostRecentCreate.ts,
      };
    }
  }

  // ── editable: the edit surface. `typedAdds` are the typed node-creation
  // tools; `structural` describes the four raw verbs a curator has for growing /
  // connecting / detaching / pruning the graph (they observe the current graph's
  // vocabulary rather than a schema).
  // ── recipes: a MIRROR of the generic recipe registry (reposition / set_content).
  // Rendered straight from RECIPES so what Claude discovers cannot drift from what
  // is built. Node CREATION is the typed authoring tools (see `typedAdds`).
  const recipes = {
    available: true,
    note: "Generic composite mutations over canonical LC: one intent → one diff → one confirmation token → one atomic draft write → one audit event. edit_node edits a node's content / position / title in place (it replaced set_content + reposition and added title editing). Node creation is add_nodes (see editable.batch); re-parenting is move_node.",
    list: RECIPES.map((r) => ({ name: r.name, summary: r.summary, params: r.params })),
  };

  const editable = {
    scope: "batched node/edge authoring + generic recipes",
    note:
      "Nodes are created via `add_nodes` (one or many — see `batch`, with the per-kind property catalog in `batch.kindProperties`); edges via `create_edges` (one or many); deletions via delete_edges / delete_nodes (see `structural.verbs`); a node's content / position / title are edited in place via `edit_node` (see `recipes`).",
    structural: {
      verbs: ["create_edges", "delete_edges", "delete_nodes"],
      // delete_nodes ALWAYS cascades the dependent subtree; the dry-run warns
      // with the full set and nothing is removed until confirm — no force flag.
      cascade: "always-with-warning",
      note:
        "create_edges adds one edge or many (usesRoutine / buildsTowards / relatesTo / hasDependency / an extra hasEducationalAlignment); edge id is deterministic (`<type>:<from>-><to>`), duplicate detection spans the batch AND the draft, and edge-type LEGALITY across labels is not enforced (deferred to human review at publish). It replaced the single create_edge. " +
        "delete_edges removes one edge or many by id in one atomic batch (all-or-nothing). " +
        "delete_nodes removes one node or many — each AND its dependent subtree (children, their children, …) plus every incident edge — in one atomic batch; the cascade spans all the ids at once, the dry-run diff shows the full set that will vanish and WARNS with it, and nothing is removed until you confirm, so seeing the cascade is the safety (no force flag). " +
        "To CREATE a node, use `add_nodes`, not create_edges.",
    },
    recipes,
    // The batched writes and their response/idempotency controls, advertised so
    // callers can feature-detect returnMode + idempotencyKey and look up the
    // per-kind property vocabulary the retired typed adds used to document.
    batch: {
      tools: ["add_nodes", "create_edges", "delete_edges", "delete_nodes"],
      params: ["returnMode", "idempotencyKey"],
      returnModes: ["summary", "full"],
      defaultReturnMode: "summary",
      idempotencyTtlHours: 24,
      // kind → the canonical LC props that kind accepts in an add_nodes item's
      // `properties` bag. add_nodes is THE node-creation tool (one or many); the
      // per-label typed adds were retired in favour of it.
      kindProperties: KIND_PROPERTIES,
      note:
        "add_nodes creates one node or many; create_edges wires many edges — each a whole batch as ONE atomic draft edit (one diff, one token, one audit record). add_nodes REPLACED the per-label typed adds (add_lesson/add_material/…): pass `kind` (the LC label) + a `properties` bag; `kindProperties` lists what each kind accepts. returnMode defaults to 'summary' — a compact `counts` object instead of the full diff (~200 KB for an 84-item batch); pass 'full' to also get the diff. idempotencyKey (a client-chosen UUID) makes a RETRIED confirm a safe replay (same key + same payload → the first apply's summary with replayed:true, no double-apply/audit; different payload → IDEMPOTENCY_KEY_MISMATCH). Keys are namespace-scoped and expire after 24h; omit for strict single-use tokens.",
    },
    coverage: {
      // Coverage is no longer coded rules on the adapter — it is the subject's
      // expectations authored as PROSE in the graph guide, reviewed on demand.
      tool: "review_draft",
      note:
        "Coverage/completeness is now authored as prose in the subject's graph guide (get_graph_guide) and checked on demand by review_draft — a read-only pre-publish pass that hands the guide's expectations + a structural snapshot to the model to reason over. The old deterministic coded coverage rules (empty chapter, one bilan, …) were retired; edits and diff_draft no longer emit automatic coverage warnings. Completeness is a review step, never a block.",
    },
  };

  // ── lifecycle: the draft promotion / discard tools and their response
  // controls, advertised so callers can feature-detect returnMode (mirrors
  // editable.batch). The role gates live in actions.canPublish /
  // actions.canDiscardDraft — this block is about response SHAPE, not authz.
  const lifecycle = {
    tools: ["publish_draft", "discard_draft"],
    params: ["returnMode"],
    returnModes: ["summary", "full"],
    defaultReturnMode: "summary",
    note:
      "publish_draft promotes the draft to live; discard_draft throws it away. Both are two-phase (dry-run → confirmationToken → confirm). returnMode defaults to 'summary' — a compact `counts` object (plus `warnings`, verbatim, on publish) instead of the whole-draft `diff`, which is 200+ KB on a large draft and can overflow the token cap and hide the confirmationToken; pass 'full' to also attach the diff (and any staged profileDiff). To inspect the full diff before promoting, call diff_draft — it is the diff endpoint; publish_draft/discard_draft return mutation summaries. Coverage warnings are preserved in BOTH modes: an approver must see them before publishing.",
  };

  // ── rules: structural rules and confirm expectation. structural
  // is imported from validate.ts so a rule description change is one file.
  const rules = {
    structural: [...STRUCTURAL_RULES],
    confirmation:
      "Every write is two-phase: call the tool once without confirm to get a diff and a confirmationToken (no state change), then call again with confirm:true and the token to actually apply. Publish/discard tokens are checked against the current draft state — if the draft moved since the dry-run, the confirm is rejected.",
  };

  // ── preview: advertise the draft-resolved preview generation surface, so
  // Claude can proactively offer "want to see what this edit generates before
  // publishing?". `available` mirrors the same readDraft gate the tool enforces;
  // `hasDraft` says whether there is anything to preview right now.
  const preview = {
    available: actions.canPreview,
    hasDraft: draftExists,
    tools: ["preview_generation", "create_preview_upload_url"],
    note:
      "preview_generation resolves the generation context from the UNPUBLISHED draft (not published) and is scoped to one Course (its containment subtree) — so you can generate a PREVIEW of the material a staged edit would produce before publishing. It closes the loop with the dry-run: dry-run shows the graph DIFF, preview shows the resulting MATERIAL. Read-only on the draft (no graph change), curator + approver only. Preview .docx output goes through create_preview_upload_url to a SEGREGATED previews/ prefix with short-lived, clearly-labelled URLs — it never touches the canonical documents bucket, list_documents, or log_generation. With no draft open, preview_generation returns a clear 'no draft to preview' notice. Draft-vs-published output comparison is a deferred follow-on.",
  };

  // ── audit: advertise the approver-only, read-only audit reader (#16), so
  // Claude can offer "want to review who changed what?" to an approver.
  // `available` mirrors the SAME readAudit gate the tool enforces (via
  // actions.canReadAudit → authorize(actor, "readAudit", ns)) — it cannot drift.
  const audit = {
    available: actions.canReadAudit,
    tool: "read_audit",
    note:
      "read_audit is a filtered, paginated, READ-ONLY view of the append-only audit log for THIS namespace, newest-first. APPROVERS ONLY (same tier as publish); curators / no-role are blocked and the blocked read is itself audited. It cannot alter, redact, or reorder any record. Namespace-scoped: to review another namespace, set_context to it (there is no namespace argument). Filters: actor, action, outcome (applied|blocked), nodeId, since/until. Modes: 'summary' (compact, no before/after — the default) and 'detail' (full before/after; also for a specific auditId). Pagination via limit (default 25, max 100) + an opaque cursor. Each call appends ONE lightweight 'read' event (actor + query + timestamp + count) — never a before/after — so 'who reviewed history' stays answerable. It is deliberately a reader, not analytics.",
  };

  // ── catalog: advertise the reusable-spec catalog (both scopes). `browse`
  // (list_catalog) is an ungated read; `canUse` (use_routine) COPIES an entry onto a
  // lesson, so it mirrors the SAME apply gate any draft edit enforces
  // (actions.canEditDraft → authorize(actor, "apply", ns)) and cannot drift.
  const catalog = {
    browse: true,
    canUse: actions.canEditDraft,
    canAdd: actions.canPublish,
    scopes: { shared: SHARED_CATALOG_NAMESPACE, workspace: catalogNamespace(activeWorkspace()) },
    tools: ["list_catalog", "get_catalog_entry", "use_routine", "use_formatter", "add_to_catalog"],
    resources: ["catalog://{scope}/{id}"],
    // Where each kind of entry ATTACHES when applied — mirrors useRoutine / useFormatter.
    applies: {
      routine: "Lesson, via usesRoutine",
      formatter: "TeachingLearningMaterial (the document), via hasPart",
    },
    note:
      "The catalog is a library of reusable instructional routines and formatters (house-style specs), read across TWO scopes: the cross-tenant SHARED library and the active workspace's own. list_catalog browses both — each entry tagged scope (shared|workspace) + kind (routine|formatter) — an ungated read; get_catalog_entry reads ONE entry's FULL authored spec (the step/formatter Material content list_catalog only counts). The same full spec is also served as an MCP resource (catalog://{scope}/{id}) for clients with a resource browser; the tool exists so it works everywhere. use_routine / use_formatter APPLY an entry (from either scope) by COPYING it: the entry's whole subtree is cloned with fresh ids into the active subject's DRAFT, so the copy is independent and later edits to the library entry do not reach it. They attach differently — use_routine links a routine to a Lesson via usesRoutine; use_formatter relabels the copy to the document layer (Formatter/FormatterSpec) and hangs it under the document's TeachingLearningMaterial via hasPart (pass the TLM id, or a Course to resolve its TLM). Formatting is a property of the DOCUMENT, not the curriculum, so it never rides a Course's usesRoutine edge. add_to_catalog is the write INVERSE: it clones a routine/formatter you authored in the active subject (an InstructionalRoutine + its steps/materials) INTO a catalog and PUBLISHES it live in one gated step — to your own workspace's library, or (super_admin only) the shared library or any workspace (omit targetWorkspace to get the choices). Because it publishes, it needs APPROVER+ in the destination workspace, or super_admin for the shared library (authorize(actor, 'publish', catalogNs) — the same policy publish_draft enforces, so it cannot drift). use_routine/use_formatter and add_to_catalog are all two-phase (dry-run returns diff + confirmationToken + a minted old→new id-map; confirm re-checks the token); the copies apply to the active draft, add_to_catalog applies-and-publishes the catalog. Seed a catalog namespace to populate it; it lists [] until then.",
  };

  // ── discovery: the generic read tools for exploring the graph. Both are
  // ungated reads; walk_graph's slot:"draft" mode is the one part that needs a
  // role, so `canWalkDraft` mirrors the SAME draft-read gate diff_draft enforces
  // (actions.canReadDraft) and cannot drift.
  const discovery = {
    tools: ["walk_graph", "walk_document", "walk_document_section", "namespace_stats", "export_graph_view"],
    canWalkDraft: actions.canReadDraft,
    walkGraph: {
      params: ["fromId", "direction", "edgeTypes", "nodeTypes", "maxDepth", "includeEdges", "limit", "cursor", "slot"],
      defaults: { limit: 50, maxDepth: 3 },
      maxLimit: 500,
      // Two independent overflow flags callers should branch on.
      pagination: "nextCursor + truncatedByLimit (more nodes remain) vs truncated (depth cap) vs truncatedBySize (byte budget trimmed the page — see hint)",
    },
    walkDocument: {
      params: ["tlmId", "slot"],
      // How the curriculum-to-render was resolved from the TLM.
      scopes: ["sections", "course", "none"],
    },
    walkDocumentSection: {
      params: ["sectionId", "slot"],
      // Anchored on the DocumentSection — the document↔curriculum binding — so the
      // routine resolves nearest-wins document-first: the section's own usesRoutine,
      // else the owning TLM's, else the covered curriculum's ancestry.
      routineResolution: "nearest-wins, document-first (section → owning TLM → covered curriculum's ancestry)",
    },
    exportGraphView: {
      params: ["fromId", "maxDepth", "detail"],
      defaults: { maxDepth: 4, detail: false },
      maxDepth: 12,
      // A slice too big to fit the response cap comes back as { tooLarge, counts, message }.
      overflow: "self-bounded — oversized detailed slice auto-drops detail; a still-too-big slice returns { tooLarge, message }",
    },
    note:
      "walk_graph is the single generic traversal: a directional (out/in/both), edge- and label-filtered, PAGINATED BFS from any node — use it to discover the framework root, a course subtree, a standards spine, anything. It replaced get_course. Page with limit (default 50, max 500) + nextCursor; do not raise the limit to fit a big result. truncatedByLimit means more nodes remain on further pages; truncated means the depth cap hid deeper nodes; truncatedBySize means a response BYTE budget trimmed the page below `limit` (raising limit won't help — set includeEdges:false and narrow nodeTypes, then page via cursor; the `hint` field says so). slot:'published' (default) reads live; slot:'draft' inspects UNPUBLISHED staged edits (curator/approver only). walk_document is the document-side counterpart: given a TeachingLearningMaterial (TLM) root it returns that document's assemblyGuide, its Formatter/FormatterSpec rendering stack, its DocumentSection spine, and the curriculum it renders (resolved by section spine or a TLM→covers→Course fallback — `scope` says which), so generation targets the document, not the raw curriculum. walk_document_section is the PER-PIECE generation entry, anchored on ONE DocumentSection — the node that already IS the document↔curriculum binding (it hangs under exactly one TLM and covers its curriculum), so it is the unit generation produces a document from, section by section: it returns the owning document, the curriculum the section renders, the routine that applies (nearest-wins, document-first — the section's own usesRoutine, else the owning TLM's, else the covered curriculum's ancestry, so a document-specific routine finally has a home), and the formatters (the TLM's doc-wide stack unioned with the section's own). namespace_stats is a cheap, argument-free orientation snapshot (node/edge counts, roots, draft state) — run it FIRST to see the shape of the graph before writing a walk; its `roots` (each with id + labels + description) surfaces the Course content roots AND the TLM document roots, so it replaced list_courses. export_graph_view returns a SELF-CONTAINED scoped slice (the containment subtree of a node) in the explorer's DisplayGraph shape — feed it to a self-contained HTML artifact to render the same interactive tree the live explorer shows; published slot only, self-bounded to the response cap.",
  };

  // ── profile: the subject profile as authored config (phase 2b). `canEdit`
  // mirrors the SAME apply gate any draft edit enforces (actions.canEditDraft →
  // authorize(actor, "apply", ns)) and cannot drift.
  const profile = {
    source: "store",
    editable: true,
    canEdit: actions.canEditDraft,
    tools: ["get_profile", "get_graph_guide", "edit_profile", "review_draft"],
    note:
      "The subject profile is a { core, guide } record: the machine `core` (config that drives parsing) plus an authored `guide` markdown the authoring/generating LLM reads to interpret and modify the graph (phase 2c — reads consume only the core; the guide never sits on the read hot path). It is AUTHORED DATA in the store's config cell: get_profile reads the record, get_graph_guide reads just the guide markdown (call it before you walk/edit the graph), and edit_profile replaces the record through the two-phase draft/publish loop — the core validated against its schema and the guide length-checked at authoring time, so a change needs no redeploy. It rides the SAME draft as curriculum edits — diff_draft/publish_draft surface a staged profile change as `profileDiff`. review_draft is a read-only pre-publish check that bundles the guide's coverage expectations with a subject-agnostic structural snapshot for the model to reason over.",
  };

  return {
    actor: {
      id: actor.id,
      isKnown: !actor.unknown,
      role: actor.role ?? null,          // legacy global claim (may be null)
      superAdmin: !!actor.superAdmin,
      effectiveRole: effectiveRole(actor, activeWorkspace()) ?? null, // role in THIS workspace
    },
    context: {
      workspace: activeWorkspace(),
      grade: adapter.grade,
      subject: adapter.subject,
      namespace,
    },
    actions,
    draft: {
      exists: draftExists,
      createdBy,
    },
    discovery,
    editable,
    lifecycle,
    profile,
    preview,
    audit,
    catalog,
    rules,
    // The universal response-size backstop every tool passes through: a payload
    // over the cap is replaced by a small RESPONSE_TOO_LARGE envelope (isError).
    // Advertised so a caller can feature-detect it and knows to paginate/narrow.
    responseCap: {
      maxBytes: Number(process.env.TLM_MAX_RESPONSE_BYTES) > 0 ? Number(process.env.TLM_MAX_RESPONSE_BYTES) : 100 * 1024,
      overflowCode: "RESPONSE_TOO_LARGE",
      envVar: "TLM_MAX_RESPONSE_BYTES",
      note: "Every tool response is capped. Well-behaved reads paginate (walk_graph, get_document_text, list_documents, read_audit, diff_draft limit) and never approach it; an oversized response returns { error: { code: 'RESPONSE_TOO_LARGE', bytes, cap }, shape, hint } instead of the payload.",
    },
  };
}

export function registerCapabilityTools(server: McpServer) {
  server.registerTool(
    "get_capabilities",
    {
      title: "What can I do right now?",
      description:
        "Report — for the currently-authenticated caller and the active grade/subject — the caller's role, exactly which write actions they may perform, whether a draft is currently open, and what wording keys are editable in the pilot. Read-only, no state change, safe for unknown callers (returns a truthful 'read/generate only' shape rather than erroring). Every field is derived from the same functions that actually ENFORCE the behavior — so this tool cannot diverge from what other tools will actually let you do.",
      inputSchema: {},
    },
    guarded(async () => asJson(await buildCapabilitiesReport())),
  );
}
