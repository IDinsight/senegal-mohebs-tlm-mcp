// ── Module: server · tool group: documents & history (bucket) ────────────────
// Reconcile, list, signed upload/download URLs, text extraction, and recording
// what was generated or ingested. "unit"/"deliverable" are the tool-facing names;
// they map to the internal history schema's chapter/type at the boundary below.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded, badDeliverable, requireConfirmation } from "./shared.js";
import { getActiveProfile } from "../profiles/index.js";
import { getStorageAdapter, extractDocxText, listEntries, recordContent, reconcile } from "../storage/index.js";

// SUBJECT-SPECIFIC (CI-maths-leaning). The structured content recorded per
// document. Fields follow the maths storybook model (characters, exampleDomains,
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
    guarded(async () => asJson(await reconcile(getActiveProfile().deliverables))));

  server.registerTool("list_documents", { title: "List tracked documents", description: "Current history: one canonical entry per document, with its known content.", inputSchema: {} },
    guarded(async () => asJson(await listEntries())));

  server.registerTool("create_upload_url", { title: "Create document upload URL", description: "Get a short-lived signed URL to upload a generated .docx to the bucket. Upload with an HTTP PUT, Content-Type application/vnd.openxmlformats-officedocument.wordprocessingml.document. relPath is like 'chapitre_05/Manuel - Chapitre 5.docx'. After uploading, call log_generation with the same relPath. REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve the upload, then call again with confirm:true.", inputSchema: { relPath: z.string(), confirm: z.boolean().optional() } },
    guarded(async (a: { relPath: string; confirm?: boolean }) => {
      const needConfirm = await requireConfirmation(server, a.confirm, `issue an upload URL for '${a.relPath}' (the file will be written to the bucket)`);
      return needConfirm ?? asJson(await getStorageAdapter().createUploadUrl(a.relPath));
    }));

  server.registerTool("create_download_url", { title: "Create document download URL", description: "Get a short-lived signed URL to download an EXISTING .docx from the bucket with an HTTP GET (no auth header needed). relPath is documents-relative, like 'chapitre_05/Manuel - Chapitre 5.docx' — the same path used by create_upload_url and get_document_text. Use this to fetch the original binary file (with its images and formatting intact) so you can edit it and re-upload via create_upload_url. Returns { url, objectKey, expiresAt, exists }; exists is false when there is no such object.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson(await getStorageAdapter().createDownloadUrl(a.relPath))));

  server.registerTool("get_document_text", { title: "Get document text", description: "Extract the plain text of a document in the bucket (by its documents-relative path) so you can read an UNTRACKED document and then record its content. When identifying characters, read the WHOLE document — characters appear in the opening scene AND in the activities and bilan, not only the amorce.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson({ relPath: a.relPath, text: await extractDocxText(a.relPath) })));

  server.registerTool("record_document_content", { title: "Record parsed document content", description: "After reading an UNTRACKED document's text, store the structured content you extracted into history so it is never re-parsed. For characters, include every one found ANYWHERE in the document (opening scene and activities/bilan), each with details like {name, type}. The object must already be in the bucket. 'unit' is the scope value (maths: chapter number); 'deliverable' is a deliverable key (maths: 'manual' or 'lessons'). REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve writing to history, then call again with confirm:true.", inputSchema: { unit: z.number().int(), deliverable: z.string(), relPath: z.string(), content: z.object(contentSchema), confirm: z.boolean().optional() } },
    guarded(async (a: { unit: number; deliverable: string; relPath: string; content: any; confirm?: boolean }) => {
      const bad = badDeliverable(a.deliverable); if (bad) return bad;
      const needConfirm = await requireConfirmation(server, a.confirm, `record content into history for unit ${a.unit} (${a.deliverable})`);
      return needConfirm ?? asJson(await recordContent("parsed", { chapter: a.unit, type: a.deliverable, relPath: a.relPath, content: a.content }));
    }));

  server.registerTool("log_generation", { title: "Log a generated document", description: "Call after uploading a generated .docx to the bucket (via create_upload_url). Reads the object's hash from storage and records what you produced so it feeds future consistency + variety. Log each character with details like {name, type} (e.g. {name:'Awa', type:'child'}), not just the name. No local file needed. 'unit' is the scope value (maths: chapter number); 'deliverable' is a deliverable key (maths: 'manual' or 'lessons'). REQUIRES CONFIRMATION: called without confirm:true it only returns a needsConfirmation notice — ask the user to approve writing to history, then call again with confirm:true.", inputSchema: { unit: z.number().int(), deliverable: z.string(), relPath: z.string(), content: z.object(contentSchema), confirm: z.boolean().optional() } },
    guarded(async (a: { unit: number; deliverable: string; relPath: string; content: any; confirm?: boolean }) => {
      const bad = badDeliverable(a.deliverable); if (bad) return bad;
      const needConfirm = await requireConfirmation(server, a.confirm, `log the generated document for unit ${a.unit} (${a.deliverable}) into history`);
      return needConfirm ?? asJson(await recordContent("pipeline", { chapter: a.unit, type: a.deliverable, relPath: a.relPath, content: a.content }));
    }));
}
