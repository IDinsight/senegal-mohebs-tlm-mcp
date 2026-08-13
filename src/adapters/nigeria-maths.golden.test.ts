/*
 * Golden-snapshot acceptance gate — Nigeria maths read projections
 *
 * Freezes the deterministic read projections the Nigeria (NERDC Primary 1–3)
 * standards spine exposes — scopeValues, listUnits, and per-theme slice /
 * progression / requiredCoverage — so a change to the parser or adapter that
 * shifts what a curator browses is caught. Seeds a memory KG store from the
 * bundle via the same path activate uses, then reads through the firestore
 * lifecycle path (identical to the deployed server).
 *
 * Regenerate ONLY when a read-projection change is intended, with:
 *   UPDATE_GOLDEN=1 npx vitest run src/adapters/nigeria-maths.golden.test.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { CONFIG } from "../config.js";
import { subjectDir, newSessionState, runInSession } from "../context/index.js";
import { resolveAdapter } from "./index.js";
import { serializeModel } from "../curriculum/index.js";
import { __setKgStoreForTest, createMemoryKgStore, kgNamespace } from "../kg-store/index.js";
import { __setStorageForTest } from "../storage/index.js";
import { __setActorForTest, type Actor } from "../actor.js";
import { activateContext } from "../activate.js";
import type { KgNodeStore, StoredMeta } from "../kg-store/index.js";
import type { StorageAdapter, HistoryFile, SubjectAdapter } from "../types.js";

const WORKSPACE = "nigeria", GRADE = "primary-1-3", SUBJECT = "maths";
const READER: Actor = { id: "reader-uid", email: "reader@test", unknown: false };
const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(HERE, "__fixtures__", "nigeria-maths.read-projections.golden.json");

const emptyHistory: HistoryFile = { version: 2, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [],
  getObjectMd5: async () => null,
  downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  createPreviewUpload: async () => ({ uploadUrl: "", downloadUrl: "", objectKey: "", contentType: "", expiresAt: "" }),
  readHistory: async () => emptyHistory,
  writeHistory: async () => {},
};

const priorEnv = process.env.KG_SOURCE;
let store: KgNodeStore;

async function seedStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  const raw = JSON.parse(readFileSync(resolve(subjectDir(WORKSPACE, GRADE, SUBJECT), CONFIG.kgFile), "utf8"));
  const adapter = resolveAdapter(GRADE, SUBJECT)!;
  const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(WORKSPACE, GRADE, SUBJECT));
  const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
  await s.writeSlot(kgNamespace(WORKSPACE, GRADE, SUBJECT), "a", { nodes, edges, meta });
  await s.ensurePointer(kgNamespace(WORKSPACE, GRADE, SUBJECT), "a");
  return s;
}

async function withCtx<T>(fn: () => Promise<T>): Promise<T> {
  return runInSession(newSessionState(), async () => {
    __setActorForTest(READER);
    const r = await activateContext(WORKSPACE, GRADE, SUBJECT);
    if (!r.ok) throw new Error(`activate: ${r.error}`);
    return fn();
  });
}

function captureProjections(adapter: SubjectAdapter) {
  const scopeValues = adapter.scopeValues();
  return {
    scopeValues,
    listUnits: adapter.listUnits(),
    themes: scopeValues.map((num) => ({
      num,
      slice: adapter.slice(num),
      progression: adapter.progression(num),
      requiredCoverage: adapter.requiredCoverage(num),
    })),
  };
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedStore();
  __setKgStoreForTest(store);
  process.env.KG_SOURCE = "firestore";
});
afterAll(() => {
  if (priorEnv === undefined) delete process.env.KG_SOURCE; else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

describe("Nigeria-maths read projections — golden gate", () => {
  it("match the committed golden snapshot", async () => {
    const actual = await withCtx(async () => captureProjections(resolveAdapter(GRADE, SUBJECT)!));

    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 2) + "\n");
    }
    if (!existsSync(GOLDEN_PATH)) {
      throw new Error(`golden fixture missing — regenerate with UPDATE_GOLDEN=1 (see file header)`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
    expect(actual).toEqual(golden);
  });

  it("covers the whole framework: 15 themes, 155 objectives", async () => {
    const { scopeValues, listUnits } = await withCtx(async () => {
      const a = resolveAdapter(GRADE, SUBJECT)!;
      return { scopeValues: a.scopeValues(), listUnits: a.listUnits() as Array<{ objectives: number }> };
    });
    expect(scopeValues).toHaveLength(15);
    expect(listUnits.reduce((n, t) => n + t.objectives, 0)).toBe(155);
  });
});
