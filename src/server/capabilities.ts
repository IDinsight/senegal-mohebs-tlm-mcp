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
    note: "Generic composite mutations over canonical LC: one intent → one diff → one confirmation token → one atomic draft write → one audit event. reposition sets a node's ordinal; set_content rewrites a Material's load-bearing content. Node creation is the typed authoring tools (see editable.typedAdds).",
    list: RECIPES.map((r) => ({ name: r.name, summary: r.summary, params: r.params })),
  };

  // The typed, LC-grounded node-creation tools — one per node type. Each attaches
  // via its canonical LC edge and copies boilerplate from a sibling; content adds
  // take an optional alignTo (hasEducationalAlignment). See server/authoring.ts.
  // `add_nodes` is the batched form — many typed adds in one atomic draft edit.
  const typedAdds = [
    "add_course", "add_lesson_grouping", "add_lesson", "add_activity", "add_assessment",
    "add_material", "add_learning_component", "add_standard_framework_item", "add_instructional_routine",
    "add_nodes",
  ];

  const editable = {
    scope: "graph primitives + typed adds + generic recipes",
    note:
      "Nodes are created via the TYPED authoring tools (see `typedAdds`); edges and deletions via the raw primitives (see `structural.verbs`); a node's ordinal and load-bearing content via the generic recipes (see `recipes` — reposition / set_content).",
    typedAdds,
    structural: {
      verbs: ["create_edge", "create_edges", "delete_edges", "delete_nodes"],
      // delete_nodes ALWAYS cascades the dependent subtree; the dry-run warns
      // with the full set and nothing is removed until confirm — no force flag.
      cascade: "always-with-warning",
      note:
        "create_edge adds an edge (usesRoutine / buildsTowards / relatesTo / hasDependency / an extra hasEducationalAlignment); edge id is deterministic (`<type>:<from>-><to>`) and edge-type LEGALITY across labels is not enforced (deferred to human review at publish). create_edges is the batched form — many edges in one atomic draft edit (duplicate detection spans the batch AND the draft). " +
        "delete_edges removes an edge by id. " +
        "delete_nodes removes a node AND its dependent subtree (children, their children, …) plus every incident edge in one atomic mutation; the dry-run diff shows the full set that will vanish and WARNS with it — nothing is removed until you confirm, so seeing the cascade is the safety (no force flag). " +
        "To CREATE a node, use the typed authoring tools (see `typedAdds`), not create_edge.",
    },
    recipes,
    // The batched writes and their response/idempotency controls, advertised so
    // callers can feature-detect returnMode + idempotencyKey.
    batch: {
      tools: ["add_nodes", "create_edges"],
      params: ["returnMode", "idempotencyKey"],
      returnModes: ["summary", "full"],
      defaultReturnMode: "summary",
      idempotencyTtlHours: 24,
      note:
        "add_nodes / create_edges apply a whole batch as ONE atomic draft edit (one diff, one token, one audit record). returnMode defaults to 'summary' — a compact `counts` object instead of the full diff (which is ~200 KB for an 84-item batch); pass 'full' to also get the diff. idempotencyKey (a client-chosen UUID) makes a RETRIED confirm a safe replay (same key + same payload → the first apply's summary with replayed:true, no double-apply/audit; different payload → IDEMPOTENCY_KEY_MISMATCH). Keys are namespace-scoped and expire after 24h; omit for strict single-use tokens.",
    },
    coverageWarnings: {
      // Whether the active subject's adapter emits completeness warnings.
      enabled: typeof adapter.coverageWarnings === "function",
      note:
        "Coverage warnings are INFORMATIONAL — they surface structural incompleteness a reviewer should see (e.g. a chapter with no lessons or no bilan, or a lesson linked to more than one chapter). They appear on an edit's dry-run and on diff_draft, and are recorded on the publish audit, but they NEVER block confirmation or publish — completeness is the human reviewer's call, not the machine's.",
    },
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
      "preview_generation resolves the generation context from the UNPUBLISHED draft (not published) and is scoped to one unit + deliverable — so you can generate a PREVIEW of the material a staged edit would produce before publishing. It closes the loop with the dry-run: dry-run shows the graph DIFF, preview shows the resulting MATERIAL. Read-only on the draft (no graph change), curator + approver only. Preview .docx output goes through create_preview_upload_url to a SEGREGATED previews/ prefix with short-lived, clearly-labelled URLs — it never touches the canonical documents bucket, list_documents, or log_generation. With no draft open, preview_generation returns a clear 'no draft to preview' notice. Draft-vs-published output comparison is a deferred follow-on.",
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
    scopes: { shared: SHARED_CATALOG_NAMESPACE, workspace: catalogNamespace(activeWorkspace()) },
    tools: ["list_catalog", "use_routine", "use_formatter"],
    note:
      "The catalog is a library of reusable instructional routines and formatters (house-style specs), read across TWO scopes: the cross-tenant SHARED library and the active workspace's own. list_catalog browses both — each entry tagged scope (shared|workspace) + kind (routine|formatter) — an ungated read. use_routine / use_formatter APPLY an entry (from either scope) by COPYING it: the entry's whole subtree is cloned with fresh ids into the active subject's DRAFT and linked via usesRoutine (a routine to a Lesson, a formatter to the Course/deliverable), so the copy is independent and later edits to the library entry do not reach it. Both are two-phase (dry-run returns diff + confirmationToken + a minted old→new id-map; confirm re-checks the token and applies to the draft) and curator-gated like any edit. Editing a catalog ENTRY is gated by its own namespace — shared entries need super_admin, workspace entries that tenant's curators. Seed a catalog namespace to populate it; it lists [] until then.",
  };

  // ── discovery: the generic read tools for exploring the graph. Both are
  // ungated reads; walk_graph's slot:"draft" mode is the one part that needs a
  // role, so `canWalkDraft` mirrors the SAME draft-read gate diff_draft enforces
  // (actions.canReadDraft) and cannot drift.
  const discovery = {
    tools: ["walk_graph", "namespace_stats"],
    canWalkDraft: actions.canReadDraft,
    walkGraph: {
      params: ["fromId", "direction", "edgeTypes", "nodeTypes", "maxDepth", "includeEdges", "limit", "cursor", "slot"],
      defaults: { limit: 50, maxDepth: 3 },
      maxLimit: 500,
      // Two independent overflow flags callers should branch on.
      pagination: "nextCursor + truncatedByLimit (page limit) vs truncated (depth cap)",
    },
    note:
      "walk_graph is the single generic traversal: a directional (out/in/both), edge- and label-filtered, PAGINATED BFS from any node — use it to discover the framework root, a course subtree, a standards spine, anything. It replaced get_course. Page with limit (default 50, max 500) + nextCursor; do not raise the limit to fit a big result. truncatedByLimit means more nodes remain on further pages; truncated means the depth cap hid deeper nodes. slot:'published' (default) reads live; slot:'draft' inspects UNPUBLISHED staged edits (curator/approver only). namespace_stats is a cheap, argument-free orientation snapshot (node/edge counts, roots, draft state) — run it FIRST to see the shape of the graph before writing a walk.",
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
    preview,
    audit,
    catalog,
    rules,
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
