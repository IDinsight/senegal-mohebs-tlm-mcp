/*
 * Module: server · aiming the generic write verbs at a CATALOG namespace
 *
 * edit_node / add_nodes / create_edges normally write to the active subject's
 * namespace. A catalog library ("senegal/_catalog/routines", the shared
 * "_shared/_catalog/routines") is an ordinary graph too — but it is not an
 * enterable context (activate.ts filters catalog partitions out of set_context),
 * so those verbs could never reach one. The practical cost: a catalog master that
 * drifted from the graph copies made with use_formatter could not be corrected —
 * a stale "[p X]" in one FormatterSpec meant re-filing a whole new entry.
 *
 * The optional `catalog` argument on those three tools routes the write here.
 * Two things differ from a subject write:
 *   • DESTINATION RIGHTS — a workspace curator is locked to their own library;
 *     writing to another workspace's, or to the shared one, needs super_admin.
 *   • LIFECYCLE — a catalog has no publish_draft (you cannot enter it to run
 *     one), so a confirmed catalog write APPLIES AND PUBLISHES in a single step.
 *     That is the same bargain add_to_catalog already makes.
 *
 * See docs/design-notes/authorable-catalog.md.
 */

import { activeWorkspace } from "../context/index.js";
import { currentActor } from "../actor.js";
import { getWorkspaceStore } from "../workspaces/index.js";
import { getKgStore, publishDraft, discardDraft } from "../kg-store/index.js";
import { SHARED_CATALOG_WORKSPACE, catalogNamespace, type CatalogScope } from "../kg-recipes/index.js";

// Which catalog the caller may write to. A workspace curator is locked to their OWN
// workspace's library. A super_admin picks — the shared library or any workspace's —
// and when they name none, we hand back the choices for the caller to ask about.
export type CatalogTarget =
  | { kind: "namespace"; workspace: string; namespace: string; scope: CatalogScope }
  | { kind: "choose"; choices: Array<{ target: string; label: string }> }
  | { kind: "error"; message: string };

export async function resolveCatalogTarget(target: string | undefined): Promise<CatalogTarget> {
  const actor = currentActor();
  const active = activeWorkspace();
  const toTarget = (workspace: string): CatalogTarget => ({
    kind: "namespace", workspace, namespace: catalogNamespace(workspace),
    scope: workspace === SHARED_CATALOG_WORKSPACE ? "shared" : "workspace",
  });

  if (!actor.superAdmin) {
    // Only a super_admin writes across catalogs; everyone else → their own workspace.
    if (target && target !== active) {
      return { kind: "error", message: `Only a super admin can add to another workspace's or the shared catalog. As a member of '${active}', you can add to that workspace's library only — omit targetWorkspace (or pass '${active}').` };
    }
    return toTarget(active);
  }
  if (target) return toTarget(target);

  // super_admin, no choice yet — offer the shared library plus every live workspace.
  const registry = await getWorkspaceStore().listWorkspaces().catch(() => []);
  const choices = [
    { target: SHARED_CATALOG_WORKSPACE, label: "Shared cross-tenant library (every workspace can use it)" },
    ...registry.filter((w) => !w.archived).map((w) => ({ target: w.id, label: `Workspace library — ${w.displayName} (${w.id})` })),
  ];
  return { kind: "choose", choices };
}

// ── the `catalog` write redirect ──────────────────────────────────────────────

// A resolved write destination: the namespace the mutation runs against, plus the
// labels the response reports it under.
export type CatalogWrite = { namespace: string; scope: CatalogScope; workspace: string };

// The result every write verb produces, whether it came back from
// runGraphMutation (edit_node) or runBatchMutation (add_nodes / create_edges).
// Deliberately untyped beyond "an object": this module only reads `phase` and
// `ok` — enough to tell a dry-run from a successful apply that needs publishing —
// and passes everything else through to the caller unchanged.
export type WriteOutcome = Record<string, unknown>;

// A successful apply is the only outcome that leaves something on the catalog's
// draft to publish. Preview, blocked, unauthorized, and failed applies do not.
function isSuccessfulApply(result: WriteOutcome): boolean {
  return result.phase === "apply" && result.ok === true;
}

// The spellings `catalog` accepts, normalized to a workspace id. "workspace" is
// the one a curator wants (their own library) without having to know its id;
// "shared" and "_shared" both mean the cross-tenant library.
function catalogWorkspaceId(catalog: string): string {
  if (catalog === "workspace") {
    return activeWorkspace();
  }
  if (catalog === "shared") {
    return SHARED_CATALOG_WORKSPACE;
  }
  return catalog;
}

// Resolve the `catalog` argument to the namespace a write lands in, or to an error
// the tool hands straight back to the caller.
async function resolveCatalogWrite(catalog: string): Promise<CatalogWrite | { error: string }> {
  const workspace = catalogWorkspaceId(catalog);
  const target = await resolveCatalogTarget(workspace);

  if (target.kind === "error") {
    return { error: target.message };
  }
  // resolveCatalogTarget only asks the caller to choose when given NO target, and
  // we always pass one — so this is unreachable. Report it rather than cast past it.
  if (target.kind === "choose") {
    return { error: `Could not resolve catalog '${catalog}'. Pass 'workspace' (your own library), 'shared', or a workspace id.` };
  }

  // A write verb amends an EXISTING library; creating one from nothing is
  // seed-time work (scripts/seed-catalog.mjs), so an unseeded catalog is an error
  // rather than an implicit bootstrap.
  const pointer = await getKgStore().readPointer(target.namespace);
  if (!pointer) {
    return { error: `The ${target.scope} catalog ('${target.namespace}') has not been seeded yet — there is nothing to edit.` };
  }

  return { namespace: target.namespace, scope: target.scope, workspace: target.workspace };
}

// Tag a dry-run so the caller knows two things the subject path would not have
// told them: confirming publishes the library live (there is no diff_draft to
// review first), and `catalog` must be re-sent on the confirm to reach the same
// namespace. Forgetting it is safe but wasteful — the confirm would hit the
// subject graph and fail the token's args check.
function withCatalogWriteNote(result: WriteOutcome, target: CatalogWrite): WriteOutcome {
  if (result.phase !== "preview") {
    return result;
  }
  return {
    ...result,
    publishesOnConfirm: true,
    catalog: { scope: target.scope, workspace: target.workspace, namespace: target.namespace },
    note: `Confirming does NOT just stage a draft — it PUBLISHES this change live into the ${target.scope} catalog ('${target.namespace}') in one step, because catalogs are not enterable contexts (no publish_draft). Re-send \`catalog\` alongside confirm:true and the token.`,
  };
}

// A catalog write's confirm tail: the mutation has landed on the catalog's DRAFT,
// so publish it. Catalogs cannot be entered, so a draft left behind could never be
// published or discarded by hand — on a refused publish we roll back rather than
// strand it (the same rollback add_to_catalog does).
async function publishCatalogWrite(target: CatalogWrite, applied: WriteOutcome): Promise<WriteOutcome> {
  const published = await publishDraft(target.namespace);
  if (!published.ok) {
    await discardDraft(target.namespace).catch(() => undefined);
    return { error: `The change was staged but publishing the ${target.scope} catalog was refused: ${published.reason}. The catalog draft was rolled back — nothing changed.` };
  }
  return {
    ...applied,
    published: true,
    catalog: { scope: target.scope, workspace: target.workspace, namespace: target.namespace },
    publishAuditId: published.auditId,
  };
}

/**
 * Run one write verb against a catalog library instead of the active subject.
 *
 * Resolves the destination (rights + seeded check), hands the namespace to `run`
 * — which does the tool's own two-phase mutation — then publishes the library on
 * a successful confirm. Dry-runs come back tagged so the caller knows the confirm
 * publishes and that `catalog` must be re-sent.
 *
 * @param catalog  the tool's `catalog` argument: "workspace" | "shared" | a workspace id
 * @param confirm  the tool's `confirm` flag (a dry-run publishes nothing)
 * @param run      runs the mutation against the resolved namespace
 * @returns the verb's own result, plus catalog labels; or `{ error }` when the
 *          destination is refused, unseeded, or the publish was rolled back
 */
export async function runCatalogWrite(
  catalog: string,
  confirm: boolean | undefined,
  run: (namespace: string) => Promise<WriteOutcome>,
): Promise<WriteOutcome> {
  const target = await resolveCatalogWrite(catalog);
  if ("error" in target) {
    return { error: target.error };
  }

  const result = await run(target.namespace);

  if (!confirm) {
    return withCatalogWriteNote(result, target);
  }
  // Blocked, unauthorized, or a failed apply — nothing reached the draft, so
  // there is nothing to publish. Hand the verb's own diagnosis back unchanged.
  if (!isSuccessfulApply(result)) {
    return result;
  }
  return publishCatalogWrite(target, result);
}
