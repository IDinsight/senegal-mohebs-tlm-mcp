/*
 * Module: server · tool group: documents & history (bucket)
 *
 * Reconcile, list, signed upload/download URLs, text extraction, and recording
 * what was generated or ingested. "unit"/"deliverable" are the tool-facing names;
 * they map to the internal history schema's unit/type at the boundary below.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded, requireConfirmation } from "./shared.js";
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
// convenience, by the transitional unit ordinal (CI maths: chapter number).
export const listDocumentsShape = {
  cursor: z.string().optional().describe("Opaque cursor from a prior page's nextCursor. Omit to start at the first document."),
  limit: z.number().int().min(1).max(MAX_PAGE).optional().describe(`Page size, 1..${MAX_PAGE} (default ${DEFAULT_PAGE}).`),
  nodeId: z.string().optional().describe("Filter to the document covering one scope node."),
  unit: z.number().int().optional().describe("Filter to one unit ordinal (CI maths: chapter number)."),
};

type DocCursor = { unit: number | null; nodeId: string };

// A unit-less entry sorts after every numbered one; mirror listEntries' Infinity.
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

// Strictly-after test in the (unit asc, nodeId asc) ordering: an entry is on the
// "next page" iff its unit rank is larger, or the ranks tie and its nodeId sorts
// later — mirroring the sort in storage/history.ts::listEntries.
const isAfterCursor = (e: HistoryEntry, c: DocCursor): boolean =>
  unitRank(e.unit) > unitRank(c.unit) || (unitRank(e.unit) === unitRank(c.unit) && e.nodeId.localeCompare(c.nodeId) > 0);

// Pure paging (+ optional nodeId/unit filtering) over the already-sorted
// history. Exported so the paging contract can be unit-tested without standing
// up the storage/adapter stack. `total` reflects the FILTERED set being paged
// (the meaningful denominator for the cursor walk); `totalUnfiltered` reports
// the whole history size so a caller can see a filter narrowed the result.
export function pageDocuments(
  all: HistoryEntry[],
  args: { cursor?: string; limit?: number; nodeId?: string; unit?: number }
): { entries: HistoryEntry[]; count: number; total: number; totalUnfiltered: number; nextCursor: string | null } | { error: string } {
  const cursor = args.cursor != null ? decodeCursor(args.cursor) : null;
  if (args.cursor != null && cursor == null) {
    return { error: "Invalid cursor — pass a cursor returned by a prior list_documents page, or omit it to start from the first document." };
  }
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  // Filters first (they define the set being paged), then the cursor slice.
  const filtered = all.filter(
    (e) => (args.nodeId == null || e.nodeId === args.nodeId) && (args.unit == null || e.unit === args.unit),
  );
  const rows = cursor ? filtered.filter((e) => isAfterCursor(e, cursor)) : filtered;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ unit: last.unit ?? null, nodeId: last.nodeId }) : null;
  return { entries: page, count: page.length, total: filtered.length, totalUnfiltered: all.length, nextCursor };
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

export function registerDocumentTools(server: McpServer) {
  server.registerTool("reconcile", { title: "Reconcile bucket with history", description: "List the .docx documents in Firebase Storage and diff against history BY relPath: tracked docs (present + unchanged), UNTRACKED docs needing a link ('new' = no history entry, 'changed' = bytes differ from the recorded entry), and entries dropped because their object is gone. It no longer classifies filenames — link each untracked doc to the node it covers with record_document_content(nodeId, relPath, content).", inputSchema: {} },
    guarded(async () => asJson(await reconcile())));

  server.registerTool("list_documents", { title: "List tracked documents", description: "Current history: one canonical entry per document, keyed by the scope node it covers (nodeId), with its known content, ordered by unit ordinal then nodeId. Paginated: pass limit (default 25, max 100) and an opaque cursor. Optional filters: nodeId (one scope node) and unit (a chapter/week ordinal). Returns { entries, count, total, totalUnfiltered, nextCursor }; nextCursor is null on the last page — pass it back to fetch the next page.", inputSchema: listDocumentsShape },
    guarded(async (a: { cursor?: string; limit?: number; nodeId?: string; unit?: number }) =>
      asJson(pageDocuments(await listEntries(), a))));

  server.registerTool("create_upload_url", { title: "Create document upload URL", description: "Get a short-lived signed URL to upload a generated .docx to the bucket. Upload with an HTTP PUT, Content-Type application/vnd.openxmlformats-officedocument.wordprocessingml.document. relPath is like 'chapitre_05/Manuel - Chapitre 5.docx'. After uploading, call log_generation with the same relPath. REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve the upload, then call again with confirm:true.", inputSchema: { relPath: z.string(), confirm: z.boolean().optional() } },
    guarded(async (a: { relPath: string; confirm?: boolean }) => {
      const needConfirm = await requireConfirmation(server, a.confirm, `issue an upload URL for '${a.relPath}' — this writes NOW to the live documents bucket (no draft, no undo)`);
      return needConfirm ?? asJson(await getStorageAdapter().createUploadUrl(a.relPath));
    }));

  server.registerTool("create_download_url", { title: "Create document download URL", description: "Get a short-lived signed URL to download an EXISTING .docx from the bucket with an HTTP GET (no auth header needed). relPath is documents-relative, like 'chapitre_05/Manuel - Chapitre 5.docx' — the same path used by create_upload_url and get_document_text. Use this to fetch the original binary file (with its images and formatting intact) so you can edit it and re-upload via create_upload_url. Returns { url, objectKey, expiresAt, exists }; exists is false when there is no such object.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson(await getStorageAdapter().createDownloadUrl(a.relPath))));

  server.registerTool("get_document_text", { title: "Get document text", description: "Extract the plain text of a document in the bucket (by its documents-relative path) so you can read an UNTRACKED document and then record its content. When identifying characters, read the WHOLE document — characters appear in the opening scene AND in the activities and bilan, not only the amorce.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson({ relPath: a.relPath, text: await extractDocxText(a.relPath) })));

  server.registerTool("record_document_content", { title: "Record parsed document content", description: "After reading an UNTRACKED document's text, store the structured content you extracted into history so it is never re-parsed. For characters, include every one found ANYWHERE in the document (opening scene and activities/bilan), each with details like {name, type}. The object must already be in the bucket. 'nodeId' is the scope node the document covers — the Chapitre/Semaine/Lesson (find it with walk_graph / namespace_stats). REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve writing to history, then call again with confirm:true.", inputSchema: { nodeId: z.string(), relPath: z.string(), content: z.object(contentSchema), confirm: z.boolean().optional() } },
    guarded(async (a: { nodeId: string; relPath: string; content: any; confirm?: boolean }) => {
      const scope = resolveScopeNode(a.nodeId); if ("error" in scope) return asJson(scope);
      const needConfirm = await requireConfirmation(server, a.confirm, `record content into history for node ${a.nodeId} — this writes NOW to the live history (no draft, no undo)`);
      return needConfirm ?? asJson(await recordContent("parsed", { nodeId: a.nodeId, unit: scope.unit, relPath: a.relPath, content: a.content }));
    }));

  server.registerTool("log_generation", { title: "Log a generated document", description: "Call after uploading a generated .docx to the bucket (via create_upload_url). Reads the object's hash from storage and records what you produced so it feeds future consistency + variety. Log each character with details like {name, type} (e.g. {name:'Awa', type:'child'}), not just the name. No local file needed. 'nodeId' is the scope node the document covers — the Chapitre/Semaine/Lesson. REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve writing to history, then call again with confirm:true.", inputSchema: { nodeId: z.string(), relPath: z.string(), content: z.object(contentSchema), confirm: z.boolean().optional() } },
    guarded(async (a: { nodeId: string; relPath: string; content: any; confirm?: boolean }) => {
      const scope = resolveScopeNode(a.nodeId); if ("error" in scope) return asJson(scope);
      const needConfirm = await requireConfirmation(server, a.confirm, `log the generated document for node ${a.nodeId} into history — this writes NOW to the live history (no draft, no undo)`);
      return needConfirm ?? asJson(await recordContent("pipeline", { nodeId: a.nodeId, unit: scope.unit, relPath: a.relPath, content: a.content }));
    }));
}

// A document's identity is its scope node, so a write must name a real node in
// the active graph. Resolve it here and surface its ordinal (the transitional
// `unit` hint domain rotation still reads); reject an unknown id rather than
// silently minting an orphan history entry.
function resolveScopeNode(nodeId: string): { unit: number | undefined } | { error: string } {
  const node = getActiveAdapter().model().byId.get(nodeId);
  if (!node) return { error: `No node '${nodeId}' in the active graph. Pass the id of the scope node this document covers (a Chapitre/Semaine/Lesson) — find it with walk_graph / namespace_stats.` };
  return { unit: node.order ?? undefined };
}
