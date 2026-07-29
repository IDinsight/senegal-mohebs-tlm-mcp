// ── Module: storage · internal ───────────────────────────────────────────────
// The history is the cache of record: one entry per (scope, deliverable), keyed
// by `${scope}:${deliverableKey}`, storing the md5 and the extracted content so a
// tracked document is never re-parsed. This file owns loading/saving it, upserts
// (record_document_content / log_generation), and reconcile() — the diff of the
// bucket against history. Deliverable specs are passed in by the caller so this
// service never imports the adapters layer.
import { getStorageAdapter, getHistCache, setHistCache } from "./adapter.js";
import { discoverDocuments } from "./documents.js";
import type { HistoryFile, HistoryEntry, DeliverableSpec, DocType, DocumentContent } from "../types.js";

async function histLoad(): Promise<HistoryFile> {
  const cached = getHistCache();
  if (cached) return cached;
  const loaded = (await getStorageAdapter().readHistory()) ?? { version: 2 as const, entries: [] };
  setHistCache(loaded);
  return loaded;
}

async function histSave() { await getStorageAdapter().writeHistory(await histLoad()); }

export async function listEntries() {
  return [...(await histLoad()).entries].sort((a, b) => a.chapter - b.chapter || a.type.localeCompare(b.type));
}

export async function getEntry(id: string) {
  return (await histLoad()).entries.find((e) => e.id === id);
}

async function histUpsert(entry: HistoryEntry) {
  const h = await histLoad();
  const i = h.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) h.entries[i] = entry; else h.entries.push(entry);
  await histSave();
}

export async function recordContent(source: "pipeline" | "parsed", input: { chapter: number; type: DocType; relPath: string; content: DocumentContent }) {
  const md5 = await getStorageAdapter().getObjectMd5(input.relPath);
  if (md5 == null) {
    return { error: `Object not found in the bucket at documents/${input.relPath}. Upload it first via create_upload_url, then call this again.` };
  }
  const entry: HistoryEntry = {
    id: `${input.chapter}:${input.type}`, chapter: input.chapter, type: input.type, relPath: input.relPath,
    md5, updated: new Date().toISOString(), source, recordedAt: new Date().toISOString(), content: input.content,
  };
  await histUpsert(entry);
  return entry;
}

export async function reconcile(deliverables: DeliverableSpec[]) {
  const h = await histLoad();
  const discovered = await discoverDocuments(deliverables);
  const byId = new Map<string, typeof discovered>();
  for (const d of discovered) (byId.get(d.id) ?? byId.set(d.id, []).get(d.id)!).push(d);

  const result = {
    tracked: [] as { id: string; relPath: string }[],
    untracked: [] as { id: string; chapter: number; type: DocType; relPath: string; reason: "new" | "changed" }[],
    dropped: [] as string[],
    duplicatesResolved: [] as { id: string; chosen: string; discarded: string[] }[],
  };

  for (const [id, docsList] of byId) {
    const known = h.entries.find((e) => e.id === id);
    let chosen: (typeof discovered)[number];
    if (docsList.length === 1) chosen = docsList[0];
    else {
      chosen = (known && docsList.find((d) => d.md5 && d.md5 === known.md5)) ?? [...docsList].sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""))[0];
      result.duplicatesResolved.push({ id, chosen: chosen.relPath, discarded: docsList.filter((d) => d !== chosen).map((d) => d.relPath) });
    }
    if (known && chosen.md5 && known.md5 === chosen.md5) result.tracked.push({ id, relPath: chosen.relPath });
    else result.untracked.push({ id, chapter: chosen.chapter, type: chosen.type, relPath: chosen.relPath, reason: known ? "changed" : "new" });
  }

  const presentIds = new Set(byId.keys());
  const before = h.entries.length;
  h.entries = h.entries.filter((e) => { if (presentIds.has(e.id)) return true; result.dropped.push(e.id); return false; });
  if (h.entries.length !== before) await histSave();
  return result;
}
