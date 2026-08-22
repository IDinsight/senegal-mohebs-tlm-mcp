// ── evaluate_document — the document-side review_draft ──────────────────────────
// The tool assembles inputs and never judges, so what matters is that it reads the
// right things: the rubrics attached to the DOCUMENT (not the curriculum), the grid's
// sections/criteria in authored order, the generated document's bucket path, and an
// actionable error when no grid is attached yet.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { listAvailableContexts, newSessionState, runInSession } from "../../context/index.js";
import { activateContext } from "../../activate.js";
import { evaluateDocument } from "../evaluate.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace, edgeId as makeEdgeId, __resetMutationsForTest,
} from "../../kg-store/index.js";
import type { StoredMeta, KgNodeStore, StoredNode, StoredEdge } from "../../kg-store/index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const CURATOR: Actor = { id: "curator-uid", email: "curator@test", role: "curator", unknown: false };
const priorEnv = process.env.KG_SOURCE;
const ns = kgNamespace("ci", "maths");

const TLM_ID = "tlm-doc";
const RUBRIC_ID = "rub-annexe8";

// The document history the bucket would hold: one generated .docx for the Course this
// TLM covers. Mutable so a test can run the "nothing generated yet" path.
let history: HistoryFile;
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [], getObjectMd5: async () => null, downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => history, writeHistory: async () => {},
};

let store: KgNodeStore;
let courseId: string;

const node = (id: string, label: string, raw: Record<string, unknown>): Omit<StoredNode, "slot"> =>
  ({ id, type: label, namespace: ns, labels: [label], spine: false, properties: { raw } });
const edge = (type: string, from: string, to: string): Omit<StoredEdge, "slot"> =>
  ({ id: makeEdgeId(type, from, to), type, from, to, namespace: ns, properties: {} });

// Seed CI maths, then hang a document off its Course with a rubric already applied —
// the state use_rubric + publish_draft leaves behind.
async function seedFreshStore(withRubric: boolean): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const ctx of listAvailableContexts()) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(ctx.workspace, ctx.grade, ctx.subject), KG_FIXTURE), "utf8"));
    const adapter = resolveAdapter(ctx.workspace, ctx.grade, ctx.subject);
    if (!adapter) continue;
    const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(ctx.grade, ctx.subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
    await s.writeSlot(kgNamespace(ctx.grade, ctx.subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(ctx.grade, ctx.subject), "a");
  }

  const strip = <T extends { slot?: unknown }>(x: T) => { const { slot: _s, ...rest } = x; return rest; };
  const [nodes, edges] = await Promise.all([s.listNodes(ns, "a"), s.listEdges(ns, "a")]);
  courseId = nodes.find((n) => (n.labels ?? []).includes("Course"))!.id;

  const extraNodes = [
    node(TLM_ID, "TeachingLearningMaterial", { description: "Guide de l'enseignant" }),
  ];
  const extraEdges = [edge("covers", TLM_ID, courseId)];

  if (withRubric) {
    extraNodes.push(
      node(RUBRIC_ID, "Rubric", { description: "Annexe 8", metadata: { scale: "oui-non", summary: "Tout Non bloque" } }),
      // Written out of order (section 2 before section 1) so the position sort is
      // actually exercised rather than accidentally satisfied by insertion order.
      node("rub-sec-b", "RubricSection", { description: "B. Genre", position: 2 }),
      node("rub-sec-a", "RubricSection", { description: "A. Contenus", position: 1, metadata: { weight: "20%" } }),
      node("rub-c-b1", "RubricCriterion", { description: "Équité", position: 1, content: "Les deux sexes sont-ils représentés équitablement ?" }),
      node("rub-c-a1", "RubricCriterion", { description: "Exactitude", position: 1, content: "Les contenus sont-ils exacts ?" }),
    );
    extraEdges.push(
      edge("hasPart", TLM_ID, RUBRIC_ID),
      edge("hasPart", RUBRIC_ID, "rub-sec-a"), edge("hasPart", RUBRIC_ID, "rub-sec-b"),
      edge("hasPart", "rub-sec-a", "rub-c-a1"), edge("hasPart", "rub-sec-b", "rub-c-b1"),
    );
  }

  const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: "test", nodeCount: nodes.length + extraNodes.length, edgeCount: edges.length + extraEdges.length };
  await s.writeSlot(ns, "a", { nodes: [...nodes.map(strip), ...extraNodes], edges: [...edges.map(strip), ...extraEdges], meta });
  return s;
}

async function inCtx<T>(fn: () => Promise<T>): Promise<T> {
  return runInSession(newSessionState(), async () => {
    __setActorForTest(CURATOR);
    const activation = await activateContext("senegal", "ci", "maths");
    if (!activation.ok) throw new Error(`activate: ${activation.error}`);
    return fn();
  });
}

async function useStore(withRubric: boolean) {
  store = await seedFreshStore(withRubric);
  __setKgStoreForTest(store);
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  history = { version: 3, entries: [] };
  __resetMutationsForTest();
  __setActorForTest(CURATOR);
  process.env.KG_SOURCE = "firestore";
  await useStore(true);
  history.entries.push({
    id: courseId, nodeId: courseId, relPath: "guide/Guide de l'enseignant.docx",
    md5: "abc", updated: "2026-08-01T00:00:00Z", source: "pipeline", recordedAt: "2026-08-01T00:00:00Z",
    content: { summary: "un guide" },
  });
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE; else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

describe("evaluate_document", () => {
  it("returns the attached grid, in authored order, with the document to read", async () => {
    const result = await inCtx(() => evaluateDocument({ nodeId: TLM_ID })) as any;

    expect(result.error).toBeUndefined();
    expect(result.reading).toBe("published");
    expect(result.document).toMatchObject({ tlmId: TLM_ID, coversNodeId: courseId, relPath: "guide/Guide de l'enseignant.docx" });

    expect(result.rubrics).toHaveLength(1);
    expect(result.rubrics[0]).toMatchObject({ id: RUBRIC_ID, name: "Annexe 8", scale: "oui-non" });
    // Sections come back in `position` order, not the order they sit in the store.
    expect(result.rubrics[0].sections.map((s: any) => s.name)).toEqual(["A. Contenus", "B. Genre"]);
    expect(result.rubrics[0].sections[0]).toMatchObject({ weight: "20%" });
    expect(result.rubrics[0].sections[0].criteria).toEqual([
      { id: "rub-c-a1", name: "Exactitude", indicator: "Les contenus sont-ils exacts ?" },
    ]);
    expect(result.criteriaCount).toBe(2);
    // The document TEXT is never inlined — a manual runs to tens of KB. The caller is
    // told to page it, and told why reading only the opening is not good enough.
    expect(result.instruction).toContain("get_document_text");
    expect(result.instruction).toContain("nextOffset is null");
    expect(JSON.stringify(result)).not.toContain("Le guide dit");
  });

  it("resolves a Course id to the document covering it", async () => {
    const result = await inCtx(() => evaluateDocument({ nodeId: courseId })) as any;
    expect(result.document.tlmId).toBe(TLM_ID);
    expect(result.rubrics).toHaveLength(1);
  });

  it("says what to do when the document carries no rubric yet", async () => {
    await useStore(false);
    const result = await inCtx(() => evaluateDocument({ nodeId: TLM_ID })) as any;
    expect(result.error).toMatch(/No rubric is attached/);
    expect(result.error).toMatch(/use_rubric/);
  });

  it("refuses a rubricId that is attached to some other document", async () => {
    const result = await inCtx(() => evaluateDocument({ nodeId: TLM_ID, rubricId: "rub-elsewhere" })) as any;
    expect(result.error).toMatch(/'rub-elsewhere' is not attached/);
  });

  it("reports there is nothing to score when no document has been generated", async () => {
    history.entries = [];
    const result = await inCtx(() => evaluateDocument({ nodeId: TLM_ID })) as any;
    // Still returns the grid — the curator can see what the document will be held to —
    // but the instruction must not tell the model to go read a file that isn't there.
    expect(result.rubrics).toHaveLength(1);
    expect(result.document.relPath).toBeNull();
    expect(result.instruction).toContain("No generated document is recorded");
    expect(result.instruction).not.toContain("get_document_text");
  });
});
