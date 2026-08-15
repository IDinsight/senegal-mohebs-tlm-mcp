import mammoth from "mammoth";
import { getStorageAdapter } from "./adapter.js";
import type { DiscoveredDoc } from "../types.js";

// Discovery no longer classifies (deliverables are gone from this path): it just
// lists the real .docx objects in the documents bucket. reconcile() diffs these
// against history BY relPath — a document's identity is the node it is linked to
// at record time, never parsed from the filename. Preview .docx live under a
// segregated previews/ prefix and never appear here.
export async function discoverDocuments(): Promise<DiscoveredDoc[]> {
  const objs = await getStorageAdapter().listDocuments();
  const out: DiscoveredDoc[] = [];
  for (const o of objs) {
    const filename = o.relPath.split("/").pop() ?? "";
    if (!filename.toLowerCase().endsWith(".docx") || filename.startsWith("~$")) continue;   // skip non-docx + Office lock files
    out.push({ relPath: o.relPath, md5: o.md5, updated: o.updated });
  }
  return out;
}

export const extractDocxText = async (relPath: string) =>
  (await mammoth.extractRawText({ buffer: await getStorageAdapter().downloadDocx(relPath) })).value;
