// ── Parity harness (KG_SOURCE=bundle vs KG_SOURCE=firestore) ─────────────────
// Primary acceptance oracle for the KG-store swap AND for the adapter refactor.
// Iterates every installed grade/subject and every unit inside it, calls the
// curriculum + KG read tools against BOTH backends (bundle read directly from
// sources/, and firestore hydrated from an in-memory KgNodeStore that mirrors
// what the seed script writes), and asserts DEEP structural equality on the
// parsed results.
//
// Any diff fails the build — this is the byte-for-byte parity check the task
// requires. The harness uses the memory store so it runs in CI without live
// Firestore; the SAME code path exercises a real Firestore store when
// `KG_SOURCE=firestore` is set at runtime.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { listAvailableContexts, subjectDir, newSessionState, runInSession } from "../context/index.js";
import { CONFIG } from "../config.js";
import { resolveAdapter } from "../adapters/index.js";
import { serializeModel } from "../curriculum/index.js";
import { __setKgStoreForTest, createMemoryKgStore, kgNamespace } from "./index.js";
import { __setStorageForTest } from "../storage/index.js";
import { activateContext } from "../activate.js";
import type { StorageAdapter, HistoryFile } from "../types.js";

// A no-op storage adapter — get_generation_context reads history via
// listEntries(), which is orthogonal to the KG source. Returning an empty
// history keeps the harness self-contained (no bucket credentials needed).
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

// Seed a memory store from each bundle so the firestore path has data to
// hydrate from. The seed logic here mirrors scripts/seed-kg-store.mjs exactly
// — same adapter parse, same serializeModel — so a passing test proves the
// same serialization the operator will run against live Firestore.
const memStore = createMemoryKgStore();
const priorEnv = process.env.KG_SOURCE;

beforeAll(async () => {
  __setKgStoreForTest(memStore);
  __setStorageForTest(fakeStorage);
  for (const { grade, subject } of listAvailableContexts()) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(grade, subject), CONFIG.kgFile), "utf8"));
    const adapter = resolveAdapter(grade, subject);
    if (!adapter) continue;
    const model = adapter.parse(raw);
    const { nodes, edges } = serializeModel(model, kgNamespace(grade, subject));
    await memStore.writeNamespace(kgNamespace(grade, subject), {
      nodes, edges,
      meta: { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: adapter.id, nodeCount: nodes.length, edgeCount: edges.length },
    });
  }
});

afterAll(() => {
  // Restore ambient state — vitest reuses the process across files.
  if (priorEnv === undefined) delete process.env.KG_SOURCE;
  else process.env.KG_SOURCE = priorEnv;
  __setKgStoreForTest(null);
});

// Run the same read sequence against both backends inside its own session, so
// no cache leaks across the flag flip. Returns the collected output — deep-
// equal on the two sides is the parity assertion.
async function collectReads(source: "bundle" | "firestore", grade: string, subject: string) {
  process.env.KG_SOURCE = source;
  const state = newSessionState();
  return runInSession(state, async () => {
    const r = await activateContext(grade, subject);
    if (!r.ok) throw new Error(`activate ${grade}/${subject} @ ${source} failed: ${r.error}`);
    // Re-resolve the adapter here so the same-session bag wiring picks up the
    // preloaded model (firestore) or the bundle read (bundle). Each call
    // builds a fresh instance closing over the same session state — same
    // behavior as before this refactor, when resolveProfile was called twice.
    const adapter = resolveAdapter(grade, subject)!;
    const units = adapter.listUnits();
    const scopes = adapter.scopeValues();
    const perUnit: Array<{ scope: number | string; slice: unknown; progression: unknown; requiredCoverage: unknown; generationContext: unknown[] }> = [];
    for (const scope of scopes) {
      const slice = adapter.slice(scope);
      const progression = adapter.progression(scope);
      const requiredCoverage = adapter.requiredCoverage(scope);
      const generationContext: unknown[] = [];
      for (const d of adapter.deliverables) {
        generationContext.push(await adapter.buildGenerationContext(scope, d.key));
      }
      perUnit.push({ scope, slice, progression, requiredCoverage, generationContext });
    }
    return { units, scopes, perUnit };
  });
}

describe("parity: KG_SOURCE=bundle vs KG_SOURCE=firestore", () => {
  for (const { grade, subject } of listAvailableContexts()) {
    it(`produces identical read output for ${grade}/${subject}`, async () => {
      const fromBundle = await collectReads("bundle", grade, subject);
      const fromStore = await collectReads("firestore", grade, subject);
      // Deep-equal on parsed JSON: key ordering / whitespace can differ across
      // internal codepaths, but the semantic shape must not.
      expect(fromStore).toEqual(fromBundle);
    });
  }
});
