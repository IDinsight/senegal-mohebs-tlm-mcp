/*
 * Module: server · tool group: documents & history (bucket)
 *
 * Reconcile, list, signed upload/download URLs, text extraction, and recording
 * what was generated or ingested. A document's identity is the graph node it
 * covers (nodeId); its chapter/week ordinal is resolved from the active graph
 * at query time (the `unit` filter/sort), not stored on the history entry.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, asText, guarded, requireConfirmation } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { getStorageAdapter, extractDocxText, listEntries, recordContent, reconcile } from "../storage/index.js";
import type { HistoryEntry } from "../types.js";

// ── list_documents pagination + filters ──────────────────────────────────────
// listEntries() is sorted (unit-hint asc, then nodeId asc) and stable, so we
// page with an opaque cursor pinned to the last entry's (unit, nodeId) — the
// same limit + cursor contract as read_audit. The cursor carries both keys so
// the ordering survives a missing unit hint (a unit-less entry sorts last, by
// nodeId).
//
// SINGLE SOURCE OF TRUTH: `listDocumentsShape` below is the ONE Zod shape used
// both as the tool's advertised `inputSchema` (so clients see the args and their
// types) AND as the runtime validator (the MCP SDK parses arguments against it
// before the handler runs). There is no second, divergent hand-rolled validator.
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

// The advertised + enforced input schema (mirrors read_audit's limit/cursor
// convention). Filter by the scope nodeId (a document's identity) or, for
// convenience, by the chapter/week ordinal (CI maths: chapter number) — the
// ordinal is resolved from the scope node in the active graph, not stored.
export const listDocumentsShape = {
  cursor: z.string().optional().describe("Opaque cursor from a prior page's nextCursor. Omit to start at the first document."),
  limit: z.number().int().min(1).max(MAX_PAGE).optional().describe(`Page size, 1..${MAX_PAGE} (default ${DEFAULT_PAGE}).`),
  nodeId: z.string().optional().describe("Filter to the document covering one scope node."),
  unit: z.number().int().optional().describe("Filter to one chapter/week ordinal (CI maths: chapter number)."),
};

type DocCursor = { unit: number | null; nodeId: string };

// A node with no ordinal (or gone from the graph) sorts after every numbered one.
const unitRank = (u: number | null | undefined): number => (u == null ? Infinity : u);

const encodeCursor = (c: DocCursor): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64");

function decodeCursor(s: string): DocCursor | null {
  try {
    const p = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as unknown;
    if (p && typeof p === "object" && typeof (p as DocCursor).nodeId === "string"
      && ((p as DocCursor).unit === null || typeof (p as DocCursor).unit === "number")) {
      return p as DocCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// Strictly-after test in the (ordinal asc, nodeId asc) ordering: an entry is on
// the "next page" iff its ordinal rank is larger, or the ranks tie and its
// nodeId sorts later.
const isAfterCursor = (ord: number | null, nodeId: string, c: DocCursor): boolean =>
  unitRank(ord) > unitRank(c.unit) || (unitRank(ord) === unitRank(c.unit) && nodeId.localeCompare(c.nodeId) > 0);

// Pure paging (+ optional nodeId/unit filtering). `ordinalOf` maps each entry's
// scope node to its chapter/week ordinal (null if the node is gone), so the
// ordinal sort/filter/cursor need no stored field. Exported so the paging
// contract can be unit-tested without standing up the storage/adapter stack.
// `total` reflects the FILTERED set being paged; `totalUnfiltered` reports the
// whole history size so a caller can see a filter narrowed the result.
export function pageDocuments(
  all: HistoryEntry[],
  ordinalOf: (nodeId: string) => number | null,
  args: { cursor?: string; limit?: number; nodeId?: string; unit?: number }
): { entries: HistoryEntry[]; count: number; total: number; totalUnfiltered: number; nextCursor: string | null } | { error: string } {
  const cursor = args.cursor != null ? decodeCursor(args.cursor) : null;
  if (args.cursor != null && cursor == null) {
    return { error: "Invalid cursor — pass a cursor returned by a prior list_documents page, or omit it to start from the first document." };
  }
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  // Resolve each entry's ordinal once, then order by (ordinal asc, nodeId asc)
  // — storage lists by nodeId only, so the ordinal ordering is applied here.
  const ordered = all
    .map((e) => ({ e, ord: ordinalOf(e.nodeId) }))
    .sort((a, b) => unitRank(a.ord) - unitRank(b.ord) || a.e.nodeId.localeCompare(b.e.nodeId));
  // Filters first (they define the set being paged), then the cursor slice.
  const filtered = ordered.filter(
    ({ e, ord }) => (args.nodeId == null || e.nodeId === args.nodeId) && (args.unit == null || ord === args.unit),
  );
  const rows = cursor ? filtered.filter(({ e, ord }) => isAfterCursor(ord, e.nodeId, cursor)) : filtered;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ unit: last.ord ?? null, nodeId: last.e.nodeId }) : null;
  return { entries: page.map((x) => x.e), count: page.length, total: filtered.length, totalUnfiltered: all.length, nextCursor };
}

// SUBJECT-SPECIFIC (CI-maths-leaning). The structured content recorded per
// document. Fields follow the CI CI CI maths storybook model (characters, exampleDomains,
// amorce/bilan wording); all optional, so subjects that don't use them omit them.
const contentSchema = {
  summary: z.string().optional(),
  characters: z
    .array(
      z.object({
        name: z.string(),
        type: z.string().optional().describe("What the character is, e.g. child, adult, teacher, market-seller, animal."),
        role: z.string().optional().describe("Optional role in the scene, e.g. pupil, mother, shopkeeper."),
        description: z.string().optional().describe("Any other distinguishing detail worth keeping consistent."),
      })
    )
    .optional()
    .describe("Characters used, each as {name, type, ...} (e.g. {name:'Awa', type:'child'}). Include every character found ANYWHERE in the document — the opening scene AND the activities/bilan — not only the amorce."),
  exampleDomains: z.array(z.string()).optional().describe("Object families used, e.g. fruits, legumes."),
  conceptsCovered: z.array(z.string()).optional().describe("OS texts / lesson ids / statementCodes covered."),
  terminologyUsed: z.array(z.string()).optional().describe("Key math terms used."),
};

// ── get_document_text paging ──────────────────────────────────────────────────
// A .docx must be downloaded + parsed whole (mammoth needs the full buffer), but
// the EXTRACTED text can be arbitrarily large — a whole chapter manual is easily
// tens of KB — so we hand it back a window at a time instead of one giant blob.
// Default window 20k chars (~5k tokens), hard ceiling 50k, paged by `offset`:
// the same read-a-range contract list_documents uses, applied to one document's
// body. Read the whole document by paging until nextOffset is null.
export const DOC_TEXT_DEFAULT_MAX_CHARS = 20_000;
export const DOC_TEXT_MAX_CHARS = 50_000;

export type DocumentTextPage = {
  relPath: string;
  offset: number;            // char index this window starts at
  returned: number;          // chars in this window
  total: number;             // total chars in the whole extracted document
  nextOffset: number | null; // offset to pass next, or null when this is the tail
  text: string;              // the window itself
};

const clampInt = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, Math.trunc(value)));

// Slice one window out of the full extracted text. Pure (no I/O) so it unit-tests
// without a live docx; the handler downloads + extracts, then calls this. A stray
// offset past the end yields an empty window with nextOffset null (a clean "no
// more"), never an error.
export function pageDocumentText(relPath: string, full: string, offset?: number, maxChars?: number): DocumentTextPage {
  const total = full.length;
  const start = clampInt(offset ?? 0, 0, total);
  const windowSize = clampInt(maxChars ?? DOC_TEXT_DEFAULT_MAX_CHARS, 1, DOC_TEXT_MAX_CHARS);
  const text = full.slice(start, start + windowSize);
  const end = start + text.length;
  return { relPath, offset: start, returned: text.length, total, nextOffset: end < total ? end : null, text };
}

export function registerDocumentTools(server: McpServer) {
  server.registerTool("reconcile", { title: "Reconcile bucket with history", description: "List the .docx documents in Firebase Storage and diff against history BY relPath: tracked docs (present + unchanged), UNTRACKED docs needing a link ('new' = no history entry, 'changed' = bytes differ from the recorded entry), and entries dropped because their object is gone. It no longer classifies filenames — link each untracked doc to the node it covers with record_document_content(nodeId, relPath, content).", inputSchema: {} },
    guarded(async () => asJson(await reconcile())));

  server.registerTool("list_documents", { title: "List tracked documents", description: "Current history: one canonical entry per document, keyed by the scope node it covers (nodeId), with its known content, ordered by unit ordinal then nodeId. Paginated: pass limit (default 25, max 100) and an opaque cursor. Optional filters: nodeId (one scope node) and unit (a chapter/week ordinal). Returns { entries, count, total, totalUnfiltered, nextCursor }; nextCursor is null on the last page — pass it back to fetch the next page.", inputSchema: listDocumentsShape },
    guarded(async (a: { cursor?: string; limit?: number; nodeId?: string; unit?: number }) => {
      const byId = getActiveAdapter().model().byId;
      return asJson(pageDocuments(await listEntries(), (id) => byId.get(id)?.order ?? null, a));
    }));

  server.registerTool("create_upload_url", { title: "Create document upload URL", description: "Get a short-lived signed URL to upload a generated .docx to the bucket. Upload with an HTTP PUT, Content-Type application/vnd.openxmlformats-officedocument.wordprocessingml.document. relPath is like 'chapitre_05/Manuel - Chapitre 5.docx'. After uploading, call log_generation with the same relPath. REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve the upload, then call again with confirm:true.", inputSchema: { relPath: z.string(), confirm: z.boolean().optional() } },
    guarded(async (a: { relPath: string; confirm?: boolean }) => {
      const needConfirm = await requireConfirmation(server, a.confirm, `issue an upload URL for '${a.relPath}' — this writes NOW to the live documents bucket (no draft, no undo)`);
      return needConfirm ?? asJson(await getStorageAdapter().createUploadUrl(a.relPath));
    }));

  server.registerTool("create_download_url", { title: "Create document download URL", description: "Get a short-lived signed URL to download an EXISTING .docx from the bucket with an HTTP GET (no auth header needed). relPath is documents-relative, like 'chapitre_05/Manuel - Chapitre 5.docx' — the same path used by create_upload_url and get_document_text. Use this to fetch the original binary file (with its images and formatting intact) so you can edit it and re-upload via create_upload_url. Returns { url, objectKey, expiresAt, exists }; exists is false when there is no such object.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson(await getStorageAdapter().createDownloadUrl(a.relPath))));

  server.registerTool("get_document_text", { title: "Get document text", description: "Extract the plain text of a document in the bucket (by its documents-relative path) so you can read an UNTRACKED document and then record its content. PAGINATED so a long document never overflows the response: one call returns a window of up to `maxChars` characters (default 20000, max 50000) starting at `offset` (default 0), plus a small JSON envelope { offset, returned, total, nextOffset } and the window as a text/plain resource. To read the WHOLE document — you must, characters appear in the opening scene AND in the activities and bilan, not only the amorce — keep calling with offset:<nextOffset> until nextOffset is null.", inputSchema: { relPath: z.string(), offset: z.number().int().optional(), maxChars: z.number().int().optional() } },
    // Two content blocks: a small JSON envelope (offset/total/nextOffset — how to
    // page) and the window itself as a text/plain resource (labelled by its
    // document path, so the reader gets rendered text, not a JSON-escaped blob).
    guarded(async (a: { relPath: string; offset?: number; maxChars?: number }) => {
      const { text, ...meta } = pageDocumentText(a.relPath, await extractDocxText(a.relPath), a.offset, a.maxChars);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(meta, null, 2) },
          ...asText(`tlm://document/${a.relPath}`, text).content,
        ],
      };
    }));

  server.registerTool("record_document_content", { title: "Record parsed document content", description: "After reading an UNTRACKED document's text, store the structured content you extracted into history so it is never re-parsed. For characters, include every one found ANYWHERE in the document (opening scene and activities/bilan), each with details like {name, type}. The object must already be in the bucket. 'nodeId' is the scope node the document covers — the Chapitre/Semaine/Lesson (find it with walk_graph / namespace_stats). REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve writing to history, then call again with confirm:true.", inputSchema: { nodeId: z.string(), relPath: z.string(), content: z.object(contentSchema), confirm: z.boolean().optional() } },
    guarded(async (a: { nodeId: string; relPath: string; content: any; confirm?: boolean }) => {
      const err = scopeNodeError(a.nodeId); if (err) return asJson({ error: err });
      const needConfirm = await requireConfirmation(server, a.confirm, `record content into history for node ${a.nodeId} — this writes NOW to the live history (no draft, no undo)`);
      return needConfirm ?? asJson(await recordContent("parsed", { nodeId: a.nodeId, relPath: a.relPath, content: a.content }));
    }));

  server.registerTool("log_generation", { title: "Log a generated document", description: "Call after uploading a generated .docx to the bucket (via create_upload_url). Reads the object's hash from storage and records what you produced so it feeds future consistency + variety. Log each character with details like {name, type} (e.g. {name:'Awa', type:'child'}), not just the name. No local file needed. 'nodeId' is the scope node the document covers — the Chapitre/Semaine/Lesson. REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve writing to history, then call again with confirm:true.", inputSchema: { nodeId: z.string(), relPath: z.string(), content: z.object(contentSchema), confirm: z.boolean().optional() } },
    guarded(async (a: { nodeId: string; relPath: string; content: any; confirm?: boolean }) => {
      const err = scopeNodeError(a.nodeId); if (err) return asJson({ error: err });
      const needConfirm = await requireConfirmation(server, a.confirm, `log the generated document for node ${a.nodeId} into history — this writes NOW to the live history (no draft, no undo)`);
      return needConfirm ?? asJson(await recordContent("pipeline", { nodeId: a.nodeId, relPath: a.relPath, content: a.content }));
    }));
}

// A document's identity is its scope node, so a write must name a real node in
// the active graph. Return an error message for an unknown id (reject rather than
// silently mint an orphan history entry), or null when the node exists.
function scopeNodeError(nodeId: string): string | null {
  if (getActiveAdapter().model().byId.has(nodeId)) return null;
  return `No node '${nodeId}' in the active graph. Pass the id of the scope node this document covers (a Chapitre/Semaine/Lesson) — find it with walk_graph / namespace_stats.`;
}
