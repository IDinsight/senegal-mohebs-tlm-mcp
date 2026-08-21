// ── glossary tools — add_terms / edit_term / remove_terms, end to end ──────────
// The workspace lexicon self-seeds on first use, rides the two-phase framework,
// auto-publishes on confirm, and then grounds get_terminology + translate. Also
// covers the auth-gated seed: an unauthorized caller neither mutates NOR creates
// the namespace.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { listAvailableContexts, newSessionState, runInSession } from "../../context/index.js";
import { subjectDir, KG_FIXTURE } from "../../__tests__/index.js";
import { resolveAdapter } from "../../adapters/index.js";
import { serializeModel } from "../../curriculum/index.js";
import {
  __setKgStoreForTest, createMemoryKgStore, kgNamespace,
  __resetMutationsForTest, __resetDraftTokensForTest,
  type KgNodeStore, type StoredMeta,
} from "../../kg-store/index.js";
import { __setStorageForTest } from "../../storage/index.js";
import { __setActorForTest, type Actor } from "../../actor.js";
import { __setWorkspaceStoreForTest, createMemoryWorkspaceStore } from "../../workspaces/index.js";
import { activateContext } from "../../activate.js";
import { glossaryNamespace, readGlossaryEntries } from "../../glossary/index.js";
import { runAddTerms, runEditTerm, runRemoveTerms } from "../glossary.js";
import { effectiveTerms, filterByQuery, filterByText } from "../glossary-read.js";
import type { StorageAdapter, HistoryFile } from "../../types.js";

const emptyHistory: HistoryFile = { version: 3, entries: [] };
const fakeStorage: StorageAdapter = {
  listDocuments: async () => [], getObjectMd5: async () => null, downloadDocx: async () => Buffer.from(""),
  createUploadUrl: async () => ({ url: "", objectKey: "", contentType: "", expiresAt: "" }),
  createDownloadUrl: async () => ({ url: "", objectKey: "", expiresAt: "", exists: false }),
  readHistory: async () => emptyHistory, writeHistory: async () => {},
};

// The tools auto-publish, so they need an approver; a curator (apply-only) is
// refused, which is what the unauthorized test checks.
const APPROVER: Actor = { id: "appr-uid", email: "appr@test", role: "approver", unknown: false };
const CURATOR: Actor = { id: "cur-uid", email: "cur@test", role: "curator", unknown: false };

let store: KgNodeStore;
const contexts = listAvailableContexts();
const targetCtx = contexts.find((c) => c.grade === "ci" && c.subject === "maths")!;
const glossaryNs = glossaryNamespace("senegal");

async function seedFreshStore(): Promise<KgNodeStore> {
  const s = createMemoryKgStore();
  for (const { workspace, grade, subject } of contexts) {
    const raw = JSON.parse(readFileSync(resolve(subjectDir(workspace, grade, subject), KG_FIXTURE), "utf8"));
    const a = resolveAdapter(workspace, grade, subject);
    if (!a) continue;
    const { nodes, edges } = serializeModel(a.parse(raw), kgNamespace(grade, subject));
    const meta: StoredMeta = { contentHash: "test", seededAt: "1970-01-01T00:00:00Z", adapterId: a.id, nodeCount: nodes.length, edgeCount: edges.length };
    await s.writeSlot(kgNamespace(grade, subject), "a", { nodes, edges, meta });
    await s.ensurePointer(kgNamespace(grade, subject), "a");
  }
  return s;
}

// Run `fn` in a session with `actor` active on CI-maths.
async function inCtx(actor: Actor, fn: () => Promise<void>): Promise<void> {
  await runInSession(newSessionState(), async () => {
    __setActorForTest(actor);
    const act = await activateContext(targetCtx.workspace, targetCtx.grade, targetCtx.subject);
    if (!act.ok) throw new Error(`activate: ${act.error}`);
    await fn();
  });
}

// Add one term end to end (dry-run → confirm), returning its minted id.
async function addOneTerm(entry: { renderings: Record<string, string>; subject?: string; tags?: string[]; example?: string }): Promise<string> {
  const preview = (await runAddTerms({ entries: [entry] })) as { phase: string; confirmationToken: string; mintedNodeIds: string[] };
  expect(preview.phase).toBe("preview");
  const applied = (await runAddTerms({ entries: [entry], mintedNodeIds: preview.mintedNodeIds, confirm: true, confirmationToken: preview.confirmationToken })) as { phase: string; ok: boolean; published: boolean };
  expect(applied.phase).toBe("apply");
  expect(applied.ok).toBe(true);
  expect(applied.published).toBe(true);
  return preview.mintedNodeIds[0];
}

beforeAll(() => { __setStorageForTest(fakeStorage); });
beforeEach(async () => {
  store = await seedFreshStore();
  __setKgStoreForTest(store);
  __setWorkspaceStoreForTest(createMemoryWorkspaceStore({
    workspaces: [{ id: "senegal", displayName: "Senegal", createdBy: "seed", createdAt: "1970-01-01T00:00:00Z" }],
  }));
  __resetMutationsForTest();
  __resetDraftTokensForTest();
  __setActorForTest(APPROVER);
});
afterAll(() => {
  __setKgStoreForTest(null);
  __setWorkspaceStoreForTest(null);
});

describe("glossary tools", () => {
  it("self-seeds the namespace, adds a term, publishes, and reads it back", async () => {
    expect(await store.readPointer(glossaryNs)).toBeNull(); // namespace does not exist yet
    await inCtx(APPROVER, async () => {
      const id = await addOneTerm({ renderings: { fr: "compter", wo: "waññ" }, tags: ["nombres"] });
      const entries = await readGlossaryEntries(glossaryNs);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ id, renderings: { fr: "compter", wo: "waññ" } });
    });
    expect(await store.readPointer(glossaryNs)).not.toBeNull(); // seeded on first use
  });

  it("grounds get_terminology (query) and translate (passage) from the published lexicon", async () => {
    await inCtx(APPROVER, async () => {
      await addOneTerm({ renderings: { fr: "compter", wo: "waññ" } });

      const byQuery = filterByQuery(await effectiveTerms(), "compter", 20);
      expect(byQuery).toHaveLength(1);
      expect(byQuery[0]).toMatchObject({ francais: "compter", wolof: "waññ" });

      // The passage contains the French rendering → the term bank includes it.
      const bank = filterByText(await effectiveTerms(), "Compte les objets: il faut compter jusqu'à dix.", 20);
      expect(bank.map((t) => t.francais)).toContain("compter");
    });
  });

  it("narrows a term to a subject: it applies only in that subject's context", async () => {
    await inCtx(APPROVER, async () => {
      await addOneTerm({ renderings: { fr: "lecture", wo: "jàng" }, subject: "reading" });
      // Active subject is maths → the reading-narrowed term does not apply.
      const terms = await effectiveTerms();
      expect(terms.map((t) => t.francais)).not.toContain("lecture");
    });
  });

  it("edits a term in place (renderings merge) and removes it", async () => {
    await inCtx(APPROVER, async () => {
      const id = await addOneTerm({ renderings: { fr: "compter", wo: "waññ" } });

      const editPreview = (await runEditTerm({ id, renderings: { wo: "waññ-v2" } })) as { phase: string; confirmationToken: string };
      expect(editPreview.phase).toBe("preview");
      await runEditTerm({ id, renderings: { wo: "waññ-v2" }, confirm: true, confirmationToken: editPreview.confirmationToken });
      expect((await readGlossaryEntries(glossaryNs))[0].renderings).toEqual({ fr: "compter", wo: "waññ-v2" });

      const rmPreview = (await runRemoveTerms({ ids: [id] })) as { phase: string; confirmationToken: string };
      expect(rmPreview.phase).toBe("preview");
      await runRemoveTerms({ ids: [id], confirm: true, confirmationToken: rmPreview.confirmationToken });
      expect(await readGlossaryEntries(glossaryNs)).toHaveLength(0);
    });
  });

  it("refuses a curator (apply-only, cannot publish) AND does not create the namespace", async () => {
    await inCtx(CURATOR, async () => {
      const result = (await runAddTerms({ entries: [{ renderings: { fr: "compter", wo: "waññ" } }] })) as { phase: string };
      expect(result.phase).toBe("unauthorized");
    });
    expect(await store.readPointer(glossaryNs)).toBeNull(); // seed was gated, never ran
  });
});
