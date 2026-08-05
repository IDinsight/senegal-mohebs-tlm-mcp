// ── Module: server · tool group: documents & history (bucket) ────────────────
// Reconcile, list, signed upload/download URLs, text extraction, and recording
// what was generated or ingested. "unit"/"deliverable" are the tool-facing names;
// they map to the internal history schema's chapter/type at the boundary below.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded, badDeliverable, requireConfirmation } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { getStorageAdapter, extractDocxText, listEntries, recordContent, reconcile } from "../storage/index.js";
import type { HistoryEntry } from "../types.js";

// ── list_documents pagination + filters ──────────────────────────────────────
// listEntries() is sorted (chapter asc, type asc) and stable, so we page with an
// opaque cursor pinned to the last entry's (chapter, type) — the same limit +
// cursor contract as read_audit. The cursor carries both keys (not the raw id
// string) because the id `${chapter}:${type}` sorts lexically, which would break
// the numeric chapter order (e.g. "10:manual" < "2:manual").
//
// SINGLE SOURCE OF TRUTH: `listDocumentsShape` below is the ONE Zod shape used
// both as the tool's advertised `inputSchema` (so clients see limit/cursor/
// chapter/type and their types) AND as the runtime validator (the MCP SDK parses
// arguments against it before the handler runs). There is no second, divergent
// hand-rolled validator — the "schema says nothing / handler enforces a number"
// split that surfaced in live testing cannot recur.
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

// The advertised + enforced input schema (mirrors read_audit's limit/cursor
// convention). `type` is a free string here — the set of valid deliverable keys
// is subject-specific and only known at runtime — validated in the handler
// against the active adapter, with a helpful error listing the valid keys.
export const listDocumentsShape = {
  cursor: z.string().optional().describe("Opaque cursor from a prior page's nextCursor. Omit to start at the first document."),
  limit: z.number().int().min(1).max(MAX_PAGE).optional().describe(`Page size, 1..${MAX_PAGE} (default ${DEFAULT_PAGE}).`),
  chapter: z.number().int().optional().describe("Filter to one unit (CI maths: chapter number)."),
  type: z.string().optional().describe("Filter to one deliverable key (CI maths: 'manual' or 'lessons')."),
};

type DocCursor = { chapter: number; type: string };

const encodeCursor = (c: DocCursor): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64");

function decodeCursor(s: string): DocCursor | null {
  try {
    const p = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as unknown;
    if (p && typeof p === "object" && typeof (p as DocCursor).chapter === "number" && typeof (p as DocCursor).type === "string") {
      return p as DocCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// Strictly-after test in the (chapter asc, type asc) ordering: an entry is on the
// "next page" iff its chapter is larger, or the chapter ties and its type sorts
// later — mirroring the sort in storage/history.ts::listEntries.
const isAfterCursor = (e: HistoryEntry, c: DocCursor): boolean =>
  e.chapter > c.chapter || (e.chapter === c.chapter && e.type.localeCompare(c.type) > 0);

// Pure paging (+ optional chapter/type filtering) over the already-sorted
// history. Exported so the paging contract can be unit-tested without standing
// up the storage/adapter stack. `total` reflects the FILTERED set being paged
// (the meaningful denominator for the cursor walk); `totalUnfiltered` reports
// the whole history size so a caller can see a filter narrowed the result.
export function pageDocuments(
  all: HistoryEntry[],
  args: { cursor?: string; limit?: number; chapter?: number; type?: string }
): { entries: HistoryEntry[]; count: number; total: number; totalUnfiltered: number; nextCursor: string | null } | { error: string } {
  const cursor = args.cursor != null ? decodeCursor(args.cursor) : null;
  if (args.cursor != null && cursor == null) {
    return { error: "Invalid cursor — pass a cursor returned by a prior list_documents page, or omit it to start from the first document." };
  }
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  // Filters first (they define the set being paged), then the cursor slice.
  const filtered = all.filter(
    (e) => (args.chapter == null || e.chapter === args.chapter) && (args.type == null || e.type === args.type),
  );
  const rows = cursor ? filtered.filter((e) => isAfterCursor(e, cursor)) : filtered;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ chapter: last.chapter, type: last.type }) : null;
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
  server.registerTool("reconcile", { title: "Reconcile bucket with history", description: "List the documents in Firebase Storage and diff against history: tracked docs, UNTRACKED docs needing ingestion, entries dropped because their object is gone, and duplicate resolutions.", inputSchema: {} },
    guarded(async () => asJson(await reconcile(getActiveAdapter().deliverables))));

  server.registerTool("list_documents", { title: "List tracked documents", description: "Current history: one canonical entry per document, with its known content, ordered by unit then deliverable. Paginated: pass limit (default 25, max 100) and an opaque cursor. Optional filters: chapter (a unit number) and type (a deliverable key — CI maths: 'manual' or 'lessons'). Returns { entries, count, total, totalUnfiltered, nextCursor }; nextCursor is null on the last page — pass it back to fetch the next page.", inputSchema: listDocumentsShape },
    guarded(async (a: { cursor?: string; limit?: number; chapter?: number; type?: string }) => {
      // `type` is validated at runtime (not in the schema) because the valid
      // deliverable keys are subject-specific and known only from the active
      // adapter — same reason record_document_content/log_generation use badDeliverable.
      if (a.type != null) { const bad = badDeliverable(a.type); if (bad) return bad; }
      return asJson(pageDocuments(await listEntries(), a));
    }));

  server.registerTool("create_upload_url", { title: "Create document upload URL", description: "Get a short-lived signed URL to upload a generated .docx to the bucket. Upload with an HTTP PUT, Content-Type application/vnd.openxmlformats-officedocument.wordprocessingml.document. relPath is like 'chapitre_05/Manuel - Chapitre 5.docx'. After uploading, call log_generation with the same relPath. REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve the upload, then call again with confirm:true.", inputSchema: { relPath: z.string(), confirm: z.boolean().optional() } },
    guarded(async (a: { relPath: string; confirm?: boolean }) => {
      const needConfirm = await requireConfirmation(server, a.confirm, `issue an upload URL for '${a.relPath}' — this writes NOW to the live documents bucket (no draft, no undo)`);
      return needConfirm ?? asJson(await getStorageAdapter().createUploadUrl(a.relPath));
    }));

  server.registerTool("create_download_url", { title: "Create document download URL", description: "Get a short-lived signed URL to download an EXISTING .docx from the bucket with an HTTP GET (no auth header needed). relPath is documents-relative, like 'chapitre_05/Manuel - Chapitre 5.docx' — the same path used by create_upload_url and get_document_text. Use this to fetch the original binary file (with its images and formatting intact) so you can edit it and re-upload via create_upload_url. Returns { url, objectKey, expiresAt, exists }; exists is false when there is no such object.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson(await getStorageAdapter().createDownloadUrl(a.relPath))));

  server.registerTool("get_document_text", { title: "Get document text", description: "Extract the plain text of a document in the bucket (by its documents-relative path) so you can read an UNTRACKED document and then record its content. When identifying characters, read the WHOLE document — characters appear in the opening scene AND in the activities and bilan, not only the amorce.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson({ relPath: a.relPath, text: await extractDocxText(a.relPath) })));

  server.registerTool("record_document_content", { title: "Record parsed document content", description: "After reading an UNTRACKED document's text, store the structured content you extracted into history so it is never re-parsed. For characters, include every one found ANYWHERE in the document (opening scene and activities/bilan), each with details like {name, type}. The object must already be in the bucket. 'unit' is the scope value (CI maths: chapter number); 'deliverable' is a deliverable key (CI maths: 'manual' or 'lessons'). REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve writing to history, then call again with confirm:true.", inputSchema: { unit: z.number().int(), deliverable: z.string(), relPath: z.string(), content: z.object(contentSchema), confirm: z.boolean().optional() } },
    guarded(async (a: { unit: number; deliverable: string; relPath: string; content: any; confirm?: boolean }) => {
      const bad = badDeliverable(a.deliverable); if (bad) return bad;
      const needConfirm = await requireConfirmation(server, a.confirm, `record content into history for unit ${a.unit} (${a.deliverable}) — this writes NOW to the live history (no draft, no undo)`);
      return needConfirm ?? asJson(await recordContent("parsed", { chapter: a.unit, type: a.deliverable, relPath: a.relPath, content: a.content }));
    }));

  server.registerTool("log_generation", { title: "Log a generated document", description: "Call after uploading a generated .docx to the bucket (via create_upload_url). Reads the object's hash from storage and records what you produced so it feeds future consistency + variety. Log each character with details like {name, type} (e.g. {name:'Awa', type:'child'}), not just the name. No local file needed. 'unit' is the scope value (CI maths: chapter number); 'deliverable' is a deliverable key (CI maths: 'manual' or 'lessons'). REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve writing to history, then call again with confirm:true.", inputSchema: { unit: z.number().int(), deliverable: z.string(), relPath: z.string(), content: z.object(contentSchema), confirm: z.boolean().optional() } },
    guarded(async (a: { unit: number; deliverable: string; relPath: string; content: any; confirm?: boolean }) => {
      const bad = badDeliverable(a.deliverable); if (bad) return bad;
      const needConfirm = await requireConfirmation(server, a.confirm, `log the generated document for unit ${a.unit} (${a.deliverable}) into history — this writes NOW to the live history (no draft, no undo)`);
      return needConfirm ?? asJson(await recordContent("pipeline", { chapter: a.unit, type: a.deliverable, relPath: a.relPath, content: a.content }));
    }));
}
