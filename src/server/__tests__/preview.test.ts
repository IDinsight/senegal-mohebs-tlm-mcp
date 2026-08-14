/*
 * preview_generation — draft-resolved preview, isolated from published
 *
 * Acceptance criteria under test (Phase 3, step 1):
 *   1. A preview built from the DRAFT reflects a staged-but-unpublished edit,
 *      while published generation (buildGenerationContext with no model) still
 *      reflects the OLD wording.
 *   2. useDraft/preview with NO draft → a clear "no draft" notice, no output.
 *   3. ISOLATION: after a preview run, the published slot, the pointer, the
 *      canonical documents bucket, history, and log_generation are all
 *      untouched; the only audit added is a PREVIEW event (never apply/publish
 *      and never a real-generation record).
 *   4. Preview output is SEGREGATED: create_preview_upload_url returns an object
 *      key under previews/, never the canonical documents/ keyspace.
 *   5. ROLE matrix: curator + approver may preview; signed-in-no-role and
 *      unknown are blocked (and the denial is audited).
 *   6. SCOPING: an unknown deliverable is rejected; a preview is scoped to the
 *      one unit asked for (no implicit whole-curriculum path).
 *   7. PARITY: the published buildGenerationContext output is unchanged for
 *      existing callers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CONFIG } from "../../config.js";
import { listAvailableContexts, subjectDir, newSessionState, runInSession, docKey, previewKey } from "../../context/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel, courseSubgraph } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  runGraphMutation, upsertProperty, __resetMutationsForTest,
} from "../../kg-store/index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import { activateContext } from "../../activate.js";
import { previewGeneration, createPreviewUploadUrl, PREVIEW_LABEL } from "../preview.js";
import type { KgNodeStore, Slot, StoredMeta } from "../../kg-store/index.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

// A storage stub that COUNTS canonical writes, so isolation tests can assert a
// preview never touches the documents bucket / history, and implements the
// preview upload path so the segregation test can inspect the object key.
const emptyHistory: HistoryFile = { version: 2, entries: [] };
let canonicalUploadCalls = 0;
let historyWrites = 0;
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [],
  getObjectMd5: async () => null,
  downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async (relPath) => { canonicalUploadCalls++; return { url: "", objectKey: docKey(relPath), contentType: "", expiresAt: "" }; },
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  createPreviewUpload: async (relPath) => ({ uploadUrl: "https://signed/put", downloadUrl: "https://signed/get", objectKey: previewKey(relPath), contentType: "docx", expiresAt: "1970-01-01T00:10:00Z" }),
  readHistory: async () => emptyHistory,
  writeHistory: async () => { historyWrites++; },
};

const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };
const APPROVER: Actor = { id: "approver-uid", email: "approver@test", role: "approver", unknown: false };
const NO_ROLE: Actor = { id: "guest-uid", email: "guest@test", unknown: false };

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;
const contexts = listAvailableContexts();
const ctx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const ns = kgNamespace(ctx.grade, ctx.subject);

async function seedFreshStore(): Promise<KgNodeStore> {
  const freshStore = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await freshStore.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await freshStore.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return freshStore;
}

// Run fn inside a session with an active CI CI maths context and a chosen actor.
async function withCtx<T>(actor: Actor | null, fn: () => Promise<T>): Promise<T> {
  const state = newSessionState();
  return runInSession(state, async () => {
    __setActorForTest(actor);
    const activation = await activateContext(ctx.workspace, ctx.grade, ctx.subject);
    if (!activation.ok) {
      throw new Error(`activate: ${activation.error}`);
    }
    return fn();
  });
}

// Order-agnostic raw slot dump (minus the slot tag) — the isolation oracle.
async function rawSlot(kgStore: KgNodeStore, slot: Slot) {
  const [nodes, edges] = await Promise.all([kgStore.listNodes(ns, slot), kgStore.listEdges(ns, slot)]);
  const strip = <T extends { slot?: string }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
  return {
    nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)).map(strip),
    edges: [...edges].sort((a, b) => a.id.localeCompare(b.id)).map(strip),
  };
}

// Pick a chapter node that carries a string title, and return its id + number.
async function pickChapter(): Promise<{ id: string; num: number; title: string }> {
  const nodes = await store.listNodes(ns, "a");
  const chapter = nodes.find((n) => n.type === "chapter" && typeof (n.properties as any).title === "string" && typeof (n.properties as any).order === "number")!;
  return { id: chapter.id, num: (chapter.properties as any).order, title: (chapter.properties as any).title };
}

// The student-book Course ("Outil de l'élève") — the id previews are scoped to.
async function pickCourse(): Promise<{ id: string }> {
  const nodes = await store.listNodes(ns, "a");
  const course = nodes.find((n) => (n.labels ?? []).includes("Course") && String((n.properties as any).raw?.description ?? "").includes("Outil de l'élève"))!;
  return { id: course.id };
}

// Stage a wording edit on the draft as `actor` (two-phase confirm).
async function stageTitleEdit(actor: Actor, nodeId: string, value: string): Promise<void> {
  await withCtx(actor, async () => {
    const adapter = resolveAdapter(ctx.grade, ctx.subject)!;
    const preview = await runGraphMutation({ namespace: ns, mutation: upsertProperty, args: { nodeId, key: "title", value, aliases: adapter.wordingAliases } });
    if (preview.phase !== "preview") {
      throw new Error(`expected preview, got ${preview.phase}`);
    }
    const applied = await runGraphMutation({ namespace: ns, mutation: upsertProperty, args: { nodeId, key: "title", value, aliases: adapter.wordingAliases }, confirm: true, token: preview.confirmationToken });
    if (applied.phase !== "apply" || !applied.ok) {
      throw new Error("apply failed");
    }
  });
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __resetMutationsForTest();
  canonicalUploadCalls = 0;
  historyWrites = 0;
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

// ── 1 + 7: preview reflects the staged edit; published still reflects the old ─
describe("draft-resolved preview reflects a staged edit; published generation does not", () => {
  it("preview subtree shows the NEW title while published shows the OLD", async () => {
    const chapter = await pickChapter();
    const course = await pickCourse();
    const NEW = `${chapter.title} — DRAFT EDIT`;
    await stageTitleEdit(CURATOR, chapter.id, NEW);

    const res = await withCtx(CURATOR, () => previewGeneration(course.id));
    expect(res.preview).toBe(true);
    expect(res.label).toBe(PREVIEW_LABEL);
    const draftNode = (res.nodes as any[]).find((n) => n.id === chapter.id);
    expect(draftNode.properties.description).toBe(NEW);

    // Published read (courseSubgraph on the published model) still old.
    const published = await withCtx(CURATOR, async () => {
      const adapter = resolveAdapter(ctx.grade, ctx.subject)!;
      return courseSubgraph(adapter.model(), course.id)!;
    }) as { nodes: Array<{ id: string; properties: any }> };
    const pubNode = published.nodes.find((n) => n.id === chapter.id)!;
    expect(pubNode.properties.description).toBe(chapter.title);
    expect(pubNode.properties.description).not.toBe(NEW);
  });
});

// ── 2: no-draft notice ──────────────────────────────────────────────────────
describe("no draft → clear notice, no output", () => {
  it("returns noDraft with a message and no subtree", async () => {
    const course = await pickCourse();
    const res = await withCtx(CURATOR, () => previewGeneration(course.id));
    expect(res.noDraft).toBe(true);
    expect(typeof res.message).toBe("string");
    expect(res.nodes).toBeUndefined();
    expect(res.label).toBeUndefined();
  });
});

// ── 3: isolation ────────────────────────────────────────────────────────────
describe("a preview run leaves everything canonical untouched", () => {
  it("published slot, pointer, bucket, history and log_generation are all unaffected", async () => {
    const chapter = await pickChapter();
    const course = await pickCourse();
    await stageTitleEdit(CURATOR, chapter.id, `${chapter.title} — DRAFT EDIT`);

    const publishedBefore = await rawSlot(store, "a");
    const pointerBefore = await store.readPointer(ns);
    const auditBefore = await store.listAudit({ namespace: ns });

    await withCtx(CURATOR, () => previewGeneration(course.id));

    // Published slot byte-for-byte identical; pointer unchanged.
    expect(await rawSlot(store, "a")).toEqual(publishedBefore);
    expect(await store.readPointer(ns)).toEqual(pointerBefore);

    // No canonical bucket write, no history write (nothing logged as a real doc).
    expect(canonicalUploadCalls).toBe(0);
    expect(historyWrites).toBe(0);

    // The ONLY new audit is a single PREVIEW event — no apply/publish, and not
    // masquerading as a real generation.
    const auditAfter = await store.listAudit({ namespace: ns });
    const added = auditAfter.filter((a) => !auditBefore.some((b) => b.id === a.id));
    expect(added.length).toBe(1);
    expect(added[0].eventType).toBe("preview");
    expect(added.some((a) => a.eventType === "apply" || a.eventType === "publish")).toBe(false);
  });
});

// ── 4: segregated preview output ────────────────────────────────────────────
describe("preview output is segregated from the canonical bucket", () => {
  it("create_preview_upload_url returns an object key under previews/, never documents/", async () => {
    const rel = "chapitre_05/Manuel - Chapitre 5.docx";
    const res = await withCtx(CURATOR, () => createPreviewUploadUrl(rel));
    expect(res.preview).toBe(true);
    expect(res.label).toBe(PREVIEW_LABEL);
    expect(typeof res.uploadUrl).toBe("string");
    expect(typeof res.downloadUrl).toBe("string");
    expect(res.objectKey as string).toContain("/previews/");
    expect(res.objectKey as string).not.toContain("/documents/");

    // The two keyspaces are structurally distinct for the same relPath.
    const { pk, dk } = await withCtx(CURATOR, async () => ({ pk: previewKey(rel), dk: docKey(rel) }));
    expect(pk).not.toBe(dk);
    expect(pk).toContain("previews/");
    expect(dk).toContain("documents/");
  });
});

// ── 5: role matrix ──────────────────────────────────────────────────────────
describe("role gate: curator + approver may preview; others blocked + audited", () => {
  it("approver may preview a staged draft", async () => {
    const chapter = await pickChapter();
    const course = await pickCourse();
    await stageTitleEdit(CURATOR, chapter.id, `${chapter.title} — DRAFT EDIT`);
    const res = await withCtx(APPROVER, () => previewGeneration(course.id));
    expect(res.preview).toBe(true);
    expect(res.nodes).toBeDefined();
  });

  for (const actor of [NO_ROLE, null]) {
    const label = actor ? `signed-in '${actor.role ?? "no-role"}'` : "unknown";
    it(`${label} is blocked (unauthorized) and the denial is audited`, async () => {
      const chapter = await pickChapter();
      const course = await pickCourse();
      await stageTitleEdit(CURATOR, chapter.id, `${chapter.title} — DRAFT EDIT`);
      const before = (await store.listAudit({ namespace: ns, eventType: "blocked" })).length;

      const res = await withCtx(actor, () => previewGeneration(course.id));
      expect(res.phase).toBe("unauthorized");
      expect(res.nodes).toBeUndefined();

      const after = (await store.listAudit({ namespace: ns, eventType: "blocked" })).length;
      expect(after).toBe(before + 1);
    });
  }

  it("create_preview_upload_url is gated the same way (no-role blocked)", async () => {
    const res = await withCtx(NO_ROLE, () => createPreviewUploadUrl("chapitre_05/x.docx"));
    expect(res.phase).toBe("unauthorized");
    expect(res.uploadUrl).toBeUndefined();
  });
});

// ── 6: scoping ──────────────────────────────────────────────────────────────
describe("preview is scoped — unknown course rejected, one course only", () => {
  it("rejects an unknown course id", async () => {
    const chapter = await pickChapter();
    await stageTitleEdit(CURATOR, chapter.id, `${chapter.title} — DRAFT EDIT`);
    const res = await withCtx(CURATOR, () => previewGeneration("no-such-course"));
    expect(typeof res.error).toBe("string");
    expect(res.nodes).toBeUndefined();
  });

  it("scopes the subtree to the requested course", async () => {
    const chapter = await pickChapter();
    const course = await pickCourse();
    await stageTitleEdit(CURATOR, chapter.id, `${chapter.title} — DRAFT EDIT`);
    const res = await withCtx(CURATOR, () => previewGeneration(course.id));
    expect(res.course).toBe(course.id);
  });
});
