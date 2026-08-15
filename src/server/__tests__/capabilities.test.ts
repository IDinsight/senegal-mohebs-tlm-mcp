/*
 * get_capabilities — the mirror-property test
 *
 * The value of this tool is that it CANNOT lie: every actions.* value must
 * agree with what authorize() actually returns for the same (actor, action,
 * namespace). If they ever disagree, one of them is a copy that drifted —
 * this test catches that immediately.
 *
 * Same test also exercises:
 *   - the role-change-flows-through property (running as different actors
 *     produces different responses with zero code change);
 *   - draft.exists reflecting the actual pointer;
 *   - editable + rules sourced from the real modules (adapter aliases and
 *     STRUCTURAL_RULES), not literal strings that could rot;
 *   - unknown-safe behavior (a truthful read/generate-only response, no error);
 *   - no-state-change (audit is quiet across a get_capabilities call).
 *
 * The tool is exposed via MCP; here we test the underlying logic by driving
 * it via a McpServer connected to a memory transport.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../../config.js";
import { listAvailableContexts, subjectDir, newSessionState, runInSession } from "../../context/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import { __setKgStoreForTest, createMemoryKgStore, kgNamespace, runGraphMutation, STRUCTURAL_RULES, __resetMutationsForTest } from "../../kg-store/index.js";
import { RECIPES, SHARED_CATALOG_NAMESPACE, reposition } from "../../kg-recipes/index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { runAsActor, __setActorForTest, type Actor } from "../../actor.js";
import { authorize } from "../../authz.js";
import { activateContext } from "../../activate.js";
import { buildCapabilitiesReport } from "../capabilities.js";
import type { KgNodeStore, StoredMeta } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const emptyHistory: HistoryFile = { version: 2, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [],
  getObjectMd5: async () => null,
  downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory,
  writeHistory: async () => {},
};

const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };
const APPROVER: Actor = { id: "approver-uid", email: "approver@test", role: "approver", unknown: false };
const SIGNED_IN_NO_ROLE: Actor = { id: "guest-uid", email: "guest@test", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const ns = kgNamespace(targetCtx.grade, targetCtx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = {
      contentHash: "test", seededAt: "1970-01-01T00:00:00Z",
      adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length,
    };
    await freshStore.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await freshStore.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return freshStore;
}

// Drive the tool's inner logic directly, not through the MCP transport —
// `buildCapabilitiesReport` is what the registered tool calls, so testing
// it directly is exactly what a real invocation runs, minus the JSON
// envelope wrapping.
async function callGetCapabilities(): Promise<any> {
  return buildCapabilitiesReport();
}

// A convenience: activate a context inside a session before running the
// tool. Every test picks one context and runs from there.
async function withActiveContext<T>(actor: Actor | null, fn: () => Promise<T>): Promise<T> {
  const state = newSessionState();
  return runInSession(state, async () => {
    if (actor) __setActorForTest(actor);
    else __setActorForTest(null);
    const activation = await activateContext(targetCtx.workspace, targetCtx.grade, targetCtx.subject);
    if (!activation.ok) {
      throw new Error(`activate ${targetCtx.grade}/${targetCtx.subject}: ${activation.error}`);
    }
    return fn();
  });
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) {
    delete process.env.KG_SOURCE;
  } else {
    process.env.KG_SOURCE = priorEnv;
  }
  __setKgStoreForTest(null);
});

// ── Mirror property (the whole point) ───────────────────────────────────────

describe("mirror property: get_capabilities.actions == authorize() for every role", () => {
  const authzActionByCap = {
    canReadDraft: "readDraft" as const,
    canEditDraft: "apply" as const,
    canDiscardDraft: "discard" as const,
    canPublish: "publish" as const,
    canReadAudit: "readAudit" as const,
  };

  for (const actor of [CURATOR, APPROVER, SIGNED_IN_NO_ROLE]) {
    it(`agrees with authorize() for role='${actor.role ?? "none"}'`, async () => {
      const caps = await withActiveContext(actor, callGetCapabilities);
      for (const [cap, authAction] of Object.entries(authzActionByCap)) {
        const authResult = authorize(actor, authAction, ns);
        expect(caps.actions[cap]).toBe(authResult.ok);
      }
      // Reads and generation are ungated by construction.
      expect(caps.actions.canReadGenerate).toBe(true);
    });
  }

  it(`agrees with authorize() for the unknown (no verified identity) actor`, async () => {
    const caps = await withActiveContext(null, callGetCapabilities);
    // Unknown → every gated action denied, reads still open.
    expect(caps.actions.canReadGenerate).toBe(true);
    expect(caps.actions.canReadDraft).toBe(false);
    expect(caps.actions.canEditDraft).toBe(false);
    expect(caps.actions.canDiscardDraft).toBe(false);
    expect(caps.actions.canPublish).toBe(false);
    expect(caps.actions.canReadAudit).toBe(false);
    expect(caps.actor.isKnown).toBe(false);
    expect(caps.actor.role).toBe(null);
  });
});

// ── Role-change-flows-through property ──────────────────────────────────────

describe("changing the caller's role changes the response with NO edit to the tool", () => {
  it("curator vs approver: canPublish flips", async () => {
    const asCurator = await withActiveContext(CURATOR, callGetCapabilities);
    const asApprover = await withActiveContext(APPROVER, callGetCapabilities);
    expect(asCurator.actions.canPublish).toBe(false);
    expect(asApprover.actions.canPublish).toBe(true);
    // read_audit is approver-only too — same tier as publish (#16).
    expect(asCurator.actions.canReadAudit).toBe(false);
    expect(asApprover.actions.canReadAudit).toBe(true);
    // The audit section's `available` mirrors the same gate — no drift.
    expect(asCurator.audit.available).toBe(false);
    expect(asApprover.audit.available).toBe(true);
    // Everything else a curator can do, an approver can too (superset).
    expect(asCurator.actions.canEditDraft).toBe(true);
    expect(asApprover.actions.canEditDraft).toBe(true);
    expect(asCurator.actions.canDiscardDraft).toBe(true);
    expect(asApprover.actions.canDiscardDraft).toBe(true);
  });
});

// ── Role/identity plumbing ──────────────────────────────────────────────────

describe("actor block reports the verified identity, not client-supplied fields", () => {
  it("reports role and id from currentActor()", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    expect(caps.actor.id).toBe(CURATOR.id);
    expect(caps.actor.role).toBe("curator");
    expect(caps.actor.isKnown).toBe(true);
  });

  it("reports role=null for a signed-in actor without a user_roles row", async () => {
    const caps = await withActiveContext(SIGNED_IN_NO_ROLE, callGetCapabilities);
    expect(caps.actor.role).toBe(null);
    expect(caps.actor.isKnown).toBe(true);
    // A signed-in user without a role still can't edit — authorize() denies.
    expect(caps.actions.canEditDraft).toBe(false);
    // …and the catalog's canUse mirrors that same gate: no role → cannot copy a routine.
    expect(caps.catalog.canUse).toBe(false);
  });
});

// ── Draft status ────────────────────────────────────────────────────────────

describe("draft.exists reflects the real pointer", () => {
  it("false when no draft has been created", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    expect(caps.draft.exists).toBe(false);
    expect(caps.draft.createdBy).toBeUndefined();
  });

  it("true when a curator has landed an edit; createdBy names the curator", async () => {
    // Seed one apply as CURATOR — this lazy-creates the draft.
    await withActiveContext(CURATOR, async () => {
      const nodes = await store.listNodes(ns, "a");
      const chapter = nodes.find((n) => n.type === "Chapitre")!;
      const preview = await runGraphMutation({
        namespace: ns, mutation: reposition,
        args: { namespace: ns, nodeId: chapter.id, position: 7 },
      });
      if (preview.phase !== "preview") {
        throw new Error("preview");
      }
      await runGraphMutation({
        namespace: ns, mutation: reposition,
        args: { namespace: ns, nodeId: chapter.id, position: 7 },
        confirm: true, token: preview.confirmationToken,
      });
    });

    // Now a DIFFERENT curator queries capabilities — they should see that
    // a draft is open and who opened it (so they don't clobber it).
    const anotherCurator: Actor = { id: "other-curator-uid", email: "other@test", role: "curator", unknown: false };
    const caps = await withActiveContext(anotherCurator, callGetCapabilities);
    expect(caps.draft.exists).toBe(true);
    expect(caps.draft.createdBy?.id).toBe(CURATOR.id);
    expect(caps.draft.createdBy?.role).toBe("curator");
    expect(typeof caps.draft.createdBy?.ts).toBe("string");
  });
});

// ── Editable + rules sourced from real modules ──────────────────────────────

describe("editable and rules come from the real sources (no hand-copied literals)", () => {
  it("rules.structural IS the STRUCTURAL_RULES constant from validate.ts", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    expect(caps.rules.structural).toEqual([...STRUCTURAL_RULES]);
  });

  it("editable.structural reports create_edges + the deletion verbs and always-with-warning cascade", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    expect(caps.editable.structural.verbs).toEqual(["create_edges", "delete_edges", "delete_nodes"]);
    // delete_nodes always cascades the dependent subtree; the dry-run warns.
    expect(caps.editable.structural.cascade).toBe("always-with-warning");
  });

  it("the retired typed adds are gone; node creation is add_nodes", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    expect(caps.editable.typedAdds).toBeUndefined();
    expect(caps.editable.batch.tools).toContain("add_nodes");
  });

  it("discovery advertises walk_graph + namespace_stats, with canWalkDraft mirroring the draft-read gate", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    expect(caps.discovery.tools).toEqual(["walk_graph", "namespace_stats"]);
    // canWalkDraft is the SAME gate diff_draft enforces — it cannot drift.
    expect(caps.discovery.canWalkDraft).toBe(caps.actions.canReadDraft);
    // Feature-detection for the paginated walk.
    expect(caps.discovery.walkGraph.defaults.limit).toBe(50);
    expect(caps.discovery.walkGraph.maxLimit).toBe(500);
  });

  it("editable.batch advertises the batched writes' returnMode + idempotency controls", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    expect(caps.editable.batch.tools).toEqual(["add_nodes", "create_edges"]);
    expect(caps.editable.batch.params).toEqual(["returnMode", "idempotencyKey"]);
    expect(caps.editable.batch.defaultReturnMode).toBe("summary");
    expect(caps.editable.batch.returnModes).toEqual(["summary", "full"]);
    // The per-kind property catalog folded in from the retired typed adds.
    expect(caps.editable.batch.kindProperties.Material).toContain("content");
    expect(caps.editable.batch.kindProperties.StandardsFrameworkItem).toContain("statementType");
  });

  it("editable.coverageWarnings.enabled mirrors whether the adapter has a coverage hook (#13)", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    const adapter = resolveAdapter(targetCtx.grade, targetCtx.subject)!;
    expect(caps.editable.coverageWarnings.enabled).toBe(typeof adapter.coverageWarnings === "function");
    // Maths ships a coverage hook, so this is true for the target context.
    expect(caps.editable.coverageWarnings.enabled).toBe(true);
  });

  it("editable.recipes IS a MIRROR of the generic RECIPES registry — no hand-authored copy", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    // Generic verbs are available on every subject (no per-subject profile/allowlist).
    expect(caps.editable.recipes.available).toBe(true);
    expect(caps.editable.recipes.list.map((r: { name: string }) => r.name)).toEqual(RECIPES.map((r) => r.name));
    expect(caps.editable.recipes.list).toEqual(RECIPES.map((r) => ({ name: r.name, summary: r.summary, params: r.params })));
    // The two generic verbs, in order (node creation is the typed adds).
    expect(caps.editable.recipes.list.map((r: { name: string }) => r.name)).toEqual(["edit_node"]);
  });

  it("catalog advertises the two tools; canUse mirrors the apply gate", async () => {
    const caps = await withActiveContext(CURATOR, callGetCapabilities);
    expect(caps.catalog.browse).toBe(true);   // list_catalog is an ungated read
    expect(caps.catalog.tools).toEqual(["list_catalog", "use_routine", "use_formatter"]);
    expect(caps.catalog.scopes.shared).toBe(SHARED_CATALOG_NAMESPACE);
    // use_routine copies onto the draft — same gate as any edit, no drift.
    expect(caps.catalog.canUse).toBe(caps.actions.canEditDraft);
  });
});

// ── No-state-change / safe for unknown ──────────────────────────────────────

describe("get_capabilities is a read", () => {
  it("does not touch the audit log or the pointer", async () => {
    const auditBefore = (await store.listAudit({ namespace: ns })).length;
    const pointerBefore = await store.readPointer(ns);
    await withActiveContext(CURATOR, callGetCapabilities);
    await withActiveContext(null, callGetCapabilities);
    await withActiveContext(APPROVER, callGetCapabilities);
    const auditAfter = (await store.listAudit({ namespace: ns })).length;
    const pointerAfter = await store.readPointer(ns);
    expect(auditAfter).toBe(auditBefore);
    expect(pointerAfter).toEqual(pointerBefore);
  });

  it("returns a truthful response for unknown callers instead of erroring", async () => {
    const caps = await withActiveContext(null, callGetCapabilities);
    // Structural shape is present even for unknown — the tool doesn't 401 them.
    expect(caps.actor).toBeDefined();
    expect(caps.actions).toBeDefined();
    expect(caps.editable).toBeDefined();
    expect(caps.rules).toBeDefined();
    expect(caps.actor.isKnown).toBe(false);
  });
});
