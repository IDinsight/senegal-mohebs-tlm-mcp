/*
 * Subject-profile config layer (phase 2b/2c) — memory backend + activate resolution.
 *
 * The profile config is a { core, guide } record that rides the SAME
 * double-buffered pointer as the graph, so the memory backend mirrors the
 * Firestore semantics these tests assert. Coverage:
 *   1. the config cell round-trips per slot, survives a graph writeSlot, is
 *      copied on createDraft, promoted on publish, and cleared on discard;
 *   2. editProfileWithConfirm is a real two-phase edit (dry-run → token →
 *      confirm staged on the draft), blocks a malformed record, and enforces
 *      stale / argsMismatch / replay / authz;
 *   3. a staged profile edit is surfaced by diffProfile and folded into the
 *      publish token, so publish can't promote an unseen profile change;
 *   4. activateContext (firestore mode) builds the adapter FROM the stored
 *      record's core, refuses an invalid one, AND still resolves a legacy FLAT
 *      cell (backward compat with a pre-2c seed);
 *   5. the authored `guide` markdown round-trips through an edit.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../../config.js";
import { listAvailableContexts, subjectDir, newSessionState, runInSession } from "../../context/index.js";
import { resolveAdapter, getRegisteredProfile, getRegisteredGuide, getActiveAdapter, validateProfileRecord } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  editProfileWithConfirm, diffProfile, diffDraft, publishDraftWithConfirm,
  runGraphMutation, __resetConfigTokensForTest, __resetDraftTokensForTest, __resetMutationsForTest,
} from "../index.js";
import { reposition } from "../../kg-recipes/index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { activateContext } from "../../activate.js";
import { runAsActor, __setActorForTest, type Actor } from "../../actor.js";
import type { KgNodeStore, StoredConfig, StoredMeta } from "../types.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const emptyHistory: HistoryFile = { version: 3, entries: [] };
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
const UNKNOWN: Actor = { id: "anon", unknown: true };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const ctx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const ns = kgNamespace(ctx.workspace, ctx.grade, ctx.subject);

// The baseline machine core, the { core, guide } record a real seed writes, and
// an injected validator mirroring the server tool's guard.
const baseCore = (): Record<string, unknown> => getRegisteredProfile(ctx.grade, ctx.subject) as unknown as Record<string, unknown>;
const recordOf = (grade: string, subject: string): StoredConfig => {
  const core = getRegisteredProfile(grade, subject);
  const guide = getRegisteredGuide(grade, subject);
  return guide !== undefined ? { core, guide } : { core };
};
const baseRecord = (): StoredConfig => recordOf(ctx.grade, ctx.subject);
const validate = (proposed: StoredConfig) => {
  try { validateProfileRecord(proposed, "test"); return { errors: [], warnings: [] }; }
  catch (e) { return { errors: [(e as Error).message], warnings: [] }; }
};

// Seed the graph into slot "a" AND write the profile record cell there, so the
// namespace looks exactly like a real phase-2b/2c seed.
async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const c of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(c.workspace, c.grade, c.subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(c.grade, c.subject);
    if (!adapter) continue;
    const nsC = kgNamespace(c.workspace, c.grade, c.subject);
    const { nodes, edges } = serializeModel(adapter.parse(raw), nsC);
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await freshStore.writeSlot(nsC, "a", { nodes, edges, meta });
    if (getRegisteredProfile(c.grade, c.subject)) await freshStore.writeConfig(nsC, "a", recordOf(c.grade, c.subject));
    await freshStore.ensurePointer(nsC, "a");
  }
  return freshStore;
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  __resetDraftTokensForTest();
  __resetConfigTokensForTest();
  __setActorForTest(null);
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE;
  else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

// A record that differs from the seeded one so a diff is observable — flip a
// capability inside the core. Still schema-valid.
function editedRecord(): StoredConfig {
  const rec = structuredClone(baseRecord()) as Record<string, unknown>;
  const caps = (rec.core as Record<string, unknown>).capabilities as Record<string, unknown>;
  caps.exampleDomainRotation = !caps.exampleDomainRotation;
  return rec as StoredConfig;
}

describe("store config cell rides the pointer", () => {
  it("round-trips per slot and survives a graph writeSlot", async () => {
    expect(await store.readConfig(ns, "a")).toMatchObject({ core: { id: "ci-maths/nodes-relationships-v1" } });
    // A graph rewrite of the same slot must NOT wipe the config cell.
    const nodes = await store.listNodes(ns, "a");
    const edges = await store.listEdges(ns, "a");
    await store.writeSlot(ns, "a", { nodes: nodes.map(({ slot, ...n }) => n), edges: edges.map(({ slot, ...e }) => e), meta: { contentHash: "x", seededAt: "x", adapterId: "x", nodeCount: nodes.length, edgeCount: edges.length } });
    expect(await store.readConfig(ns, "a")).toMatchObject({ core: { id: "ci-maths/nodes-relationships-v1" } });
  });

  it("createDraft copies the config into the draft cell; discard clears it", async () => {
    await store.createDraft(ns);
    const pointer = await store.readPointer(ns);
    expect(pointer?.draftSlot).toBe("b");
    expect(await store.readConfig(ns, "b")).toMatchObject({ core: { id: "ci-maths/nodes-relationships-v1" } });
    await store.discardDraft(ns);
    expect((await store.readPointer(ns))?.draftSlot).toBe(null);
  });
});

describe("editProfileWithConfirm — two-phase", () => {
  it("dry-run previews a diff + token and changes no state; confirm stages on the draft", async () => {
    await runAsActor(CURATOR, async () => {
      const proposed = editedRecord();
      const preview = await editProfileWithConfirm(ns, proposed, { validate });
      expect(preview.phase).toBe("preview");
      if (preview.phase !== "preview") throw new Error("expected preview");
      expect(preview.diff.after).toMatchObject(proposed as Record<string, unknown>);
      // No draft yet — dry-run is side-effect-free.
      expect((await store.readPointer(ns))?.draftSlot).toBe(null);

      const applied = await editProfileWithConfirm(ns, proposed, { confirm: true, token: preview.confirmationToken, validate });
      expect(applied.phase).toBe("apply");
      if (applied.phase !== "apply" || !applied.ok) throw new Error("expected ok apply");
      // Draft lazy-created; the staged record is on the draft, published untouched.
      const pointer = await store.readPointer(ns);
      expect(pointer?.draftSlot).toBe("b");
      expect(await store.readConfig(ns, "b")).toMatchObject(proposed as Record<string, unknown>);
      const publishedCore = (await store.readConfig(ns, "a") as { core: Record<string, unknown> }).core;
      expect(publishedCore.capabilities).not.toMatchObject((proposed as { core: { capabilities: Record<string, unknown> } }).core.capabilities);
    });
  });

  it("blocks a malformed core at dry-run with no token", async () => {
    await runAsActor(CURATOR, async () => {
      const bad = { core: { ...(baseCore()), deliverables: "not-an-array" } } as StoredConfig;
      const res = await editProfileWithConfirm(ns, bad, { validate });
      expect(res.phase).toBe("blocked");
      if (res.phase !== "blocked") throw new Error("expected blocked");
      expect(res.errors.length).toBeGreaterThan(0);
      expect((res as { confirmationToken?: string }).confirmationToken).toBeUndefined();
    });
  });

  it("blocks an over-long guide", async () => {
    await runAsActor(CURATOR, async () => {
      const bad = { core: baseCore(), guide: "x".repeat(100_001) } as StoredConfig;
      const res = await editProfileWithConfirm(ns, bad, { validate });
      expect(res.phase).toBe("blocked");
    });
  });

  it("rejects a confirm whose record differs from the previewed one (argsMismatch)", async () => {
    await runAsActor(CURATOR, async () => {
      const preview = await editProfileWithConfirm(ns, editedRecord(), { validate });
      if (preview.phase !== "preview") throw new Error("expected preview");
      // A confirm carrying a DIFFERENT record than the one previewed (distinct core id).
      const different = structuredClone(baseRecord()) as Record<string, unknown>;
      (different.core as Record<string, unknown>).id = "ci-maths/some-other-profile";
      const res = await editProfileWithConfirm(ns, different as StoredConfig, { confirm: true, token: preview.confirmationToken, validate });
      expect(res.phase === "apply" && res.ok === false && res.reason === "argsMismatch").toBe(true);
    });
  });

  it("rejects a stale confirm after the base record moved", async () => {
    await runAsActor(CURATOR, async () => {
      const proposed = editedRecord();
      const preview = await editProfileWithConfirm(ns, proposed, { validate });
      if (preview.phase !== "preview") throw new Error("expected preview");
      // A DIFFERENT profile edit lands first, moving the base.
      const other = structuredClone(baseRecord()) as Record<string, unknown>;
      (other.core as Record<string, unknown>).id = "ci-maths/moved";
      const firstPreview = await editProfileWithConfirm(ns, other as StoredConfig, { validate });
      if (firstPreview.phase !== "preview") throw new Error("expected preview");
      await editProfileWithConfirm(ns, other as StoredConfig, { confirm: true, token: firstPreview.confirmationToken, validate });
      // The original token now confirms against a moved base → stale.
      const res = await editProfileWithConfirm(ns, proposed, { confirm: true, token: preview.confirmationToken, validate });
      expect(res.phase === "apply" && res.ok === false && res.reason === "stale").toBe(true);
    });
  });

  it("rejects a replayed token", async () => {
    await runAsActor(CURATOR, async () => {
      const proposed = editedRecord();
      const preview = await editProfileWithConfirm(ns, proposed, { validate });
      if (preview.phase !== "preview") throw new Error("expected preview");
      const first = await editProfileWithConfirm(ns, proposed, { confirm: true, token: preview.confirmationToken, validate });
      expect(first.phase === "apply" && first.ok === true).toBe(true);
      const replay = await editProfileWithConfirm(ns, proposed, { confirm: true, token: preview.confirmationToken, validate });
      expect(replay.phase === "apply" && replay.ok === false && replay.reason === "invalidToken").toBe(true);
    });
  });

  it("denies a non-curator", async () => {
    await runAsActor(UNKNOWN, async () => {
      const res = await editProfileWithConfirm(ns, editedRecord(), { validate });
      expect(res.phase).toBe("unauthorized");
    });
  });

  it("round-trips an edited guide onto the draft", async () => {
    await runAsActor(CURATOR, async () => {
      const rec = structuredClone(baseRecord()) as Record<string, unknown>;
      rec.guide = "# New guide\n\nAuthored prose for the LLM.";
      const preview = await editProfileWithConfirm(ns, rec as StoredConfig, { validate });
      if (preview.phase !== "preview") throw new Error("expected preview");
      await editProfileWithConfirm(ns, rec as StoredConfig, { confirm: true, token: preview.confirmationToken, validate });
      const draft = await store.readConfig(ns, "b") as { guide?: string };
      expect(draft.guide).toBe("# New guide\n\nAuthored prose for the LLM.");
      expect((await diffProfile(ns)).changed).toBe(true);
    });
  });
});

describe("staged profile is visible to the draft view and guards publish", () => {
  it("diffProfile reports the staged change; publish promotes it", async () => {
    await runAsActor(CURATOR, async () => {
      const proposed = editedRecord();
      const preview = await editProfileWithConfirm(ns, proposed, { validate });
      if (preview.phase !== "preview") throw new Error("expected preview");
      await editProfileWithConfirm(ns, proposed, { confirm: true, token: preview.confirmationToken, validate });

      const pd = await diffProfile(ns);
      expect(pd.changed).toBe(true);
      const whole = await diffDraft(ns);
      expect(whole.profileDiff?.changed).toBe(true);
    });

    // Approver publishes (curators cannot publish); the record is promoted.
    await runAsActor(APPROVER, async () => {
      const pubPreview = await publishDraftWithConfirm(ns);
      if (pubPreview.phase !== "preview" || !pubPreview.confirmationToken) throw new Error("expected publish preview");
      const pub = await publishDraftWithConfirm(ns, { confirm: true, token: pubPreview.confirmationToken });
      expect(pub.phase === "commit" && pub.ok === true).toBe(true);
      expect(await store.readConfig(ns, (await store.readPointer(ns))!.publishedSlot)).toMatchObject(editedRecord() as Record<string, unknown>);
    });
  });

  it("a profile edit that lands after a publish dry-run invalidates the publish token", async () => {
    // Curator stages a graph edit so there IS a draft to publish.
    await runAsActor(CURATOR, async () => {
      const chapter = (await store.listNodes(ns, "a")).find((n) => n.type === "Chapitre")!;
      const gp = await runGraphMutation({ namespace: ns, mutation: reposition, args: { namespace: ns, nodeId: chapter.id, position: 9 } });
      if (gp.phase !== "preview") throw new Error("expected preview");
      await runGraphMutation({ namespace: ns, mutation: reposition, args: { namespace: ns, nodeId: chapter.id, position: 9 }, confirm: true, token: gp.confirmationToken });
    });

    // Approver dry-runs publish → token bound to the current graph+profile fingerprint.
    let pubToken = "";
    await runAsActor(APPROVER, async () => {
      const pubPreview = await publishDraftWithConfirm(ns);
      if (pubPreview.phase !== "preview" || !pubPreview.confirmationToken) throw new Error("expected publish preview");
      pubToken = pubPreview.confirmationToken;
    });

    // A profile edit then lands on the same draft, moving the profile fingerprint.
    await runAsActor(CURATOR, async () => {
      const proposed = editedRecord();
      const ep = await editProfileWithConfirm(ns, proposed, { validate });
      if (ep.phase !== "preview") throw new Error("expected preview");
      await editProfileWithConfirm(ns, proposed, { confirm: true, token: ep.confirmationToken, validate });
    });

    // The stale publish token must be rejected — the approver never saw the profile edit.
    await runAsActor(APPROVER, async () => {
      const pub = await publishDraftWithConfirm(ns, { confirm: true, token: pubToken });
      expect(pub.phase === "commit" && pub.ok === false).toBe(true);
    });
  });
});

describe("activateContext builds the adapter from the stored record (firestore mode)", () => {
  it("reflects a stored record edit and refuses an invalid stored record", async () => {
    // Write an edited (still valid) record to the published cell, then activate.
    const edited = editedRecord();
    await store.writeConfig(ns, "a", edited);
    const state = newSessionState();
    await runInSession(state, async () => {
      const res = await activateContext(ctx.workspace, ctx.grade, ctx.subject);
      expect(res.ok).toBe(true);
      const adapter = getActiveAdapter();
      expect(adapter.capabilities.exampleDomainRotation).toBe((edited as { core: { capabilities: { exampleDomainRotation: boolean } } }).core.capabilities.exampleDomainRotation);
    });

    // A malformed stored record is refused (would otherwise mis-parse a whole workspace).
    await store.writeConfig(ns, "a", { core: { id: "broken" } } as StoredConfig);
    const state2 = newSessionState();
    await runInSession(state2, async () => {
      const res = await activateContext(ctx.workspace, ctx.grade, ctx.subject);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected refusal");
      expect(res.error).toMatch(/invalid/i);
    });
  });

  it("still resolves a legacy FLAT profile cell (pre-2c seed)", async () => {
    // A namespace seeded before the split has a bare SubjectProfile in the cell,
    // not a { core, guide } record. It must keep resolving until re-seeded.
    await store.writeConfig(ns, "a", baseCore() as StoredConfig);
    const state = newSessionState();
    await runInSession(state, async () => {
      const res = await activateContext(ctx.workspace, ctx.grade, ctx.subject);
      expect(res.ok).toBe(true);
      expect(getActiveAdapter().id).toBe("ci-maths/nodes-relationships-v1");
    });
  });
});
