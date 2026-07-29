import mammoth from "mammoth";
import { getStorageAdapter } from "./adapter.js";
import { firstInt } from "../utils/index.js";
import type { DeliverableSpec, DiscoveredDoc } from "../types.js";

// Classification is per-subject, so the deliverable specs are passed in by the
// caller (the app layer, which owns the active adapter). This keeps storage a
// pure service that never reaches up into adapters.
export async function discoverDocuments(deliverables: DeliverableSpec[]): Promise<DiscoveredDoc[]> {
  const objs = await getStorageAdapter().listDocuments();
  const out: DiscoveredDoc[] = [];
  for (const o of objs) {
    const segments = o.relPath.split("/");
    if (segments.length < 2) continue;               // must live under a scope subfolder
    const chapter = firstInt(segments[0]);
    if (chapter == null) continue;
    const filename = segments[segments.length - 1];
    if (!filename.toLowerCase().endsWith(".docx") || filename.startsWith("~$")) continue;
    const spec = deliverables.find((d) => d.classify(filename));
    if (!spec) continue;
    out.push({ id: `${chapter}:${spec.key}`, chapter, type: spec.key, relPath: o.relPath, md5: o.md5, updated: o.updated });
  }
  return out;
}

export const extractDocxText = async (relPath: string) =>
  (await mammoth.extractRawText({ buffer: await getStorageAdapter().downloadDocx(relPath) })).value;
