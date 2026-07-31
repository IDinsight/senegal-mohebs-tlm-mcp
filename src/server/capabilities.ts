// ── Module: server · tool group: get_capabilities ────────────────────────────
// A read-only mirror of what the current caller can do RIGHT NOW: role,
// allowed actions, whether a draft exists, what's editable, and the safety
// rules in force. Never a second source of truth — every field is sourced
// from the module that ACTUALLY enforces or defines it:
//
//   actor.role           ← currentActor()               (from #1's verified JWT)
//   actions.*            ← authorize(actor, X, ns)      (from #8, the real gate)
//   draft.exists         ← store.readPointer()           (from #4)
//   draft.createdBy      ← store.listAudit()             (from #7)
//   editable.keys        ← adapter.wordingAliases       (from #10's adapter surface)
//   editable.safePaths   ← UPSERT_PROPERTY_SAFE_PATHS   (from #10's central allowlist)
//   rules.structural     ← STRUCTURAL_RULES              (from #6)
//
// Any calculation of "who can do what" done here would be a copy that could
// drift. The mirror-property test asserts every actions.* value matches
// what authorize() returns for the same (actor, action, namespace).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { currentActor } from "../actor.js";
import { authorize, type AuthAction } from "../authz.js";
import {
  kgNamespace, getKgStore, UPSERT_PROPERTY_SAFE_PATHS, STRUCTURAL_RULES,
  STRUCTURAL_EDIT_SAFE_PATHS, RECIPES,
} from "../kg-store/index.js";

// The five actions this server has today. Kept as a const-tuple so the
// response shape is stable and the mirror-property test can iterate over
// the same set the tool reports.
const CAPABILITY_ACTIONS = [
  "canReadGenerate",  // reads and generation are ungated (no authorize() call needed)
  "canReadDraft",     // #9's diff_draft
  "canEditDraft",     // #10's upsert_property (any apply)
  "canDiscardDraft",  // #9's discard_draft
  "canPublish",       // #9's publish_draft
] as const;

// Map each capability action to the underlying authz action name, when
// authorize() is what gates it. `canReadGenerate` has no gate — reads are
// open to unknown actors too.
const CAPABILITY_TO_AUTHZ: Record<Exclude<typeof CAPABILITY_ACTIONS[number], "canReadGenerate">, AuthAction> = {
  canReadDraft: "readDraft",
  canEditDraft: "apply",
  canDiscardDraft: "discard",
  canPublish: "publish",
};

// The inner logic, exported so tests can drive it without spinning up an
// McpServer. `registerCapabilityTools` just wraps this in the MCP tool
// envelope.
export async function buildCapabilitiesReport(): Promise<Record<string, unknown>> {
  const adapter = getActiveAdapter();
  const namespace = kgNamespace(adapter.grade, adapter.subject);
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

  // ── editable: sourced from #10 (wording) + #12 (structural). The active
  // adapter's wordingAliases is a live object (not a copy) — an adapter
  // change flows through to this response with no code edit here.
  // `safePaths` is the central allowlist; converted to a sorted array so
  // the JSON is stable. `structural` describes the four raw verbs a
  // curator has for growing / connecting / detaching / pruning the graph;
  // they observe the current graph's vocabulary rather than a schema.
  // ── recipes: a MIRROR of the recipe registry (#14). Rendered straight from
  // RECIPES so what Claude discovers cannot drift from what is built. Available
  // only when the active subject's adapter declares a recipeProfile.
  const recipesAvailable = !!adapter.recipeProfile && !!adapter.structuralAliases;
  const recipes = {
    available: recipesAvailable,
    note: recipesAvailable
      ? "Recipes are COMPOSITE mutations: one intent → one whole-composite diff → one confirmation token → one atomic draft write → one audit event. They are the ergonomic layer over the raw structural verbs, made safe by the same referential-integrity floor. `renumberBearing` marks a recipe that changes an existing chapter's number; `regimeGated` marks one whose correctness depends on rewriting the maths chapter-number join key (chapitreNum) across the affected lessons — the recipe does that rewrite atomically so nothing drifts."
      : `Composite recipes are not available for ${adapter.grade}/${adapter.subject} (its adapter declares no recipeProfile) — only wording edits and the raw structural verbs are.`,
    list: recipesAvailable ? RECIPES.map((r) => ({
      name: r.name,
      summary: r.summary,
      params: r.params,
      renumberBearing: r.renumberBearing,
      regimeGated: r.regimeGated,
    })) : [],
  };

  const editable = {
    scope: "term-wording + structural verbs + structural-property edits + composite recipes",
    note:
      "Wording (chapter titles, lesson objectives, component/task descriptions) is editable via upsert_property. " +
      "The graph structure is editable via four raw primitives (see `structural.verbs`) AND via composite recipes (see `recipes`). " +
      "Structural PROPERTIES of existing nodes (a chapter's number, a lesson's position) are editable only THROUGH the recipes (see `structuralKeys`), never by upsert_property.",
    keysByNodeKind: adapter.wordingAliases,
    safePaths: [...UPSERT_PROPERTY_SAFE_PATHS].sort(),
    // Structural-property editing of EXISTING nodes (#14). Sourced from the
    // adapter's structuralAliases (the logical keys) + the central
    // STRUCTURAL_EDIT_SAFE_PATHS allowlist (the storage paths a recipe may
    // touch). These are edited only inside the recipes — there is no direct
    // structural-edit tool by design.
    structuralKeys: {
      keysByNodeKind: adapter.structuralAliases ?? {},
      safePaths: [...STRUCTURAL_EDIT_SAFE_PATHS].sort(),
      note:
        "Editable only through the recipes (renumber changes a chapter's number and cascades to its lessons; move_lesson/split_chapter rewrite a moved lesson's chapter-membership number). Values are NUMERIC (order/number), not wording. There is deliberately no raw structural-property tool.",
    },
    structural: {
      verbs: ["create_node", "link_nodes", "unlink_nodes", "delete_node"],
      // delete_node cascades ONLY on an explicit force:true — never implicitly.
      cascade: "explicit-force-only",
      note:
        "create_node mints a server-side id and sets properties at BIRTH (missing wording surfaces as a WARNING, not a block). " +
        "link_nodes adds an edge; edge id is deterministic (`<type>:<from>-><to>`) and edge-type LEGALITY across kinds is not enforced (deferred to human review at publish). " +
        "unlink_nodes removes an edge by id. " +
        "delete_node by default REFUSES to remove a node with incident edges (detach with unlink_nodes first); pass force:true to cascade-delete the node AND its dependent subtree (children, their children, …) plus every incident edge in one atomic mutation — the dry-run diff shows the full set that will vanish. Cascade never happens without explicit force. " +
        "For curriculum-meaningful edits (add/split/move a chapter or lesson, renumber) prefer the composite `recipes` over hand-sequencing these verbs.",
    },
    recipes,
    coverageWarnings: {
      // Whether the active subject's adapter emits completeness warnings.
      enabled: typeof adapter.coverageWarnings === "function",
      note:
        "Coverage warnings are INFORMATIONAL — they surface structural incompleteness a reviewer should see (e.g. a chapter with no lessons or no bilan, a lesson linked to more than one chapter, or a maths lesson whose chapitreNum disagrees with the chapter it's linked to). They appear on an edit's dry-run and on diff_draft, and are recorded on the publish audit, but they NEVER block confirmation or publish — completeness is the human reviewer's call, not the machine's.",
    },
  };

  // ── rules: structural rules and confirm expectation. structural
  // is imported from validate.ts so a rule description change is one file.
  const rules = {
    structural: [...STRUCTURAL_RULES],
    confirmation:
      "Every write is two-phase: call the tool once without confirm to get a diff and a confirmationToken (no state change), then call again with confirm:true and the token to actually apply. Publish/discard tokens are checked against the current draft state — if the draft moved since the dry-run, the confirm is rejected.",
  };

  return {
    actor: {
      id: actor.id,
      isKnown: !actor.unknown,
      role: actor.role ?? null,
    },
    context: {
      grade: adapter.grade,
      subject: adapter.subject,
      namespace,
    },
    actions,
    draft: {
      exists: draftExists,
      createdBy,
    },
    editable,
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
