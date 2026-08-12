/*
 * Golden-snapshot acceptance gate — CE1-reading read projections
 *
 * The reading content-layer step (docs/design-notes/graph-native-authoring.md,
 * Scope A) restructures the source graph and parse (week→LessonGrouping; one
 * content Lesson per language-tool standard). Like the maths gate, this freezes
 * the deterministic read projections — listUnits, slice, progression,
 * requiredCoverage, scopeValues — so the change proves it kept them
 * byte-identical (its acceptance test). buildGenerationContext (characters,
 * themes) is deliberately out of scope.
 *
 * The golden fixture is committed. Regenerate it ONLY when a change to the read
 * projections is intended, with:  UPDATE_GOLDEN=1 npx vitest run src/adapters/ce1-reading.golden.test.ts
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

const GRADE = "ce1", SUBJECT = "reading";
const READER: Actor = { id: "reader-uid", email: "reader@test", unknown: false };
const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(HERE, "__fixtures__", "ce1-reading.read-projections.golden.json");

// Read projections touch no storage; a no-op stub keeps activateContext happy.
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
  const raw = JSON.parse(readFileSync(resolve(subjectDir(GRADE, SUBJECT), CONFIG.kgFile), "utf8"));
  const adapter = resolveAdapter(GRADE, SUBJECT)!;
  const { nodes, edges } = serializeModel(adapter.parse(raw), kgNamespace(GRADE, SUBJECT));
  const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length };
  await s.writeSlot(kgNamespace(GRADE, SUBJECT), "a", { nodes, edges, meta });
  await s.ensurePointer(kgNamespace(GRADE, SUBJECT), "a");
  return s;
}

async function withCtx<T>(fn: () => Promise<T>): Promise<T> {
  return runInSession(newSessionState(), async () => {
    __setActorForTest(READER);
    const r = await activateContext(GRADE, SUBJECT);
    if (!r.ok) throw new Error(`activate: ${r.error}`);
    return fn();
  });
}

// The deterministic read projections, gathered per unit (a week for reading).
function captureProjections(adapter: SubjectAdapter) {
  const scopeValues = adapter.scopeValues();
  return {
    scopeValues,
    listUnits: adapter.listUnits(),
    units: scopeValues.map((num) => ({
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

describe("CE1-reading read projections — golden gate", () => {
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
});
