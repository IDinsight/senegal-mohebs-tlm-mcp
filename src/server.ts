// ── Layer: app ───────────────────────────────────────────────────────────────
// Defines the MCP tool surface. This is the only layer that reads the active
// profile (getActiveProfile) and dispatches to it — curriculum, generation, and
// deliverable validation all flow through the profile here, so the service
// modules stay unaware of profiles. Every source-/bucket-dependent tool is
// wrapped in guarded() so it prompts for a context instead of throwing.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { CONFIG } from "./config.js";
import { sourcePath, getActiveContext, listAvailableContexts, ContextNotSetError } from "./context-state.js";
import { activateContext } from "./activate.js";
import { getActiveProfile } from "./profiles/index.js";
import { getStorageAdapter, extractDocxText, listEntries, recordContent, reconcile } from "./storage/index.js";
import { searchTerminology, terminologySections } from "./curriculum/index.js";
import { suggestFreshDomain, domainUsage } from "./generation/index.js";

const asJson = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
type ToolResult = ReturnType<typeof asJson>;

// Wrap a tool handler so that, when no grade/subject is active, the server asks
// the caller to pick one (and lists the options) instead of throwing. Every
// source- or bucket-dependent tool is registered through this.
const guarded = <A>(fn: (a: A) => ToolResult | Promise<ToolResult>) => async (a: A): Promise<ToolResult> => {
  try {
    return await fn(a);
  } catch (e) {
    if (e instanceof ContextNotSetError) {
      return asJson({
        needsContext: true,
        message: "No grade/subject is selected yet. Ask the user which grade and subject to work on, then call set_context. Available options are listed below.",
        available: e.available,
      });
    }
    throw e;
  }
};

// Validate a deliverable key against the active profile. Returns an error
// ToolResult when the key isn't one this subject produces, so the openness of
// the deliverable set is enforced at runtime (the schema can't be a fixed enum,
// since the valid keys depend on the context chosen at runtime).
const badDeliverable = (key: string): ToolResult | null => {
  const keys = getActiveProfile().deliverables.map((d) => d.key);
  return keys.includes(key) ? null : asJson({ error: `Unknown deliverable '${key}' for the active subject. Valid deliverables: ${keys.join(", ")}.` });
};

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

export function buildServer(): McpServer {
  const server = new McpServer({ name: "senegal-mohebs-tlm-server", version: "0.4.0" });

  // ── Teaching context: choose grade + subject before anything else ──────────
  server.registerTool("set_context", { title: "Set grade & subject", description: "Choose the grade (e.g. 'ci') and subject (e.g. 'maths') to work on. This selects which local sources load and which Firebase namespace documents and history live under, and MUST be set before any other tool. If you don't know which to use, call get_context to list the installed options, then ask the user.", inputSchema: { grade: z.string(), subject: z.string() } },
    async (a) => { const r = activateContext(a.grade, a.subject); return asJson(r.ok ? { ok: true, active: r.context, available: listAvailableContexts() } : r); });

  server.registerTool("get_context", { title: "Get grade & subject", description: "Return the currently selected grade/subject (null if none is set yet) and every installed grade/subject option. Use this to discover what's available, then set_context.", inputSchema: {} },
    async () => asJson({ active: getActiveContext(), available: listAvailableContexts() }));

  // ── Curriculum (local sources, scoped to the active grade/subject) ─────────
  server.registerTool("list_chapters", { title: "List chapters", description: "All chapters from the KG (number, title, domain). Numbering may skip.", inputSchema: {} },
    guarded(async () => asJson(getActiveProfile().curriculum.listUnits())));

  server.registerTool("get_curriculum", { title: "Get chapter curriculum", description: "The KG slice for a chapter: ordered lessons (OS) with components and tasks, the bilan lesson, and cross-chapter progression.", inputSchema: { chapter: z.number().int() } },
    guarded(async (a: { chapter: number }) => { const c = getActiveProfile().curriculum; const s = c.slice(a.chapter); return s ? asJson({ ...(s as object), progression: c.progression(a.chapter) }) : asJson({ error: `Chapter ${a.chapter} not found.` }); }));

  server.registerTool("get_terminology", { title: "Get terminology (FR/Wolof)", description: "Search the MOHEBS French/Wolof terminology used as the fallback when the KG lacks a term's wording. Returns [] if nothing matches — then say the wording is missing rather than invent it.", inputSchema: { query: z.string(), limit: z.number().int().optional() } },
    guarded(async (a: { query: string; limit?: number }) => asJson({ query: a.query, results: searchTerminology(a.query, a.limit ?? 20) })));

  server.registerTool("terminology_sections", { title: "Terminology sections", description: "List terminology sections and entry counts.", inputSchema: {} },
    guarded(async () => asJson(terminologySections())));

  server.registerTool("get_prompt", { title: "Get generation prompt", description: "Return the chapter or lessons generation prompt (the md files you manage).", inputSchema: { which: z.enum(["chapter", "lessons"]) } },
    guarded(async (a: { which: "chapter" | "lessons" }) => asJson({ which: a.which, text: readFileSync(sourcePath(a.which === "chapter" ? CONFIG.chapterPromptFile : CONFIG.lessonsPromptFile), "utf8") })));

  server.registerTool("get_generation_context", { title: "Get generation context", description: "One call to load before generating: curriculum for the unit, plus subject-specific context (for maths: established characters, a fresh example-domain suggestion, and — for the teacher guide — the manual to build on). 'docType' is a deliverable key for the active subject (maths: 'manual' or 'lessons').", inputSchema: { chapter: z.number().int(), docType: z.string() } },
    guarded(async (a: { chapter: number; docType: string }) => badDeliverable(a.docType) ?? asJson(await getActiveProfile().buildGenerationContext(a.chapter, a.docType))));

  server.registerTool("suggest_fresh_domain", { title: "Suggest fresh example domain", description: "Suggest an unused (or least-recently-used) example domain so chapters rotate object families.", inputSchema: {} },
    guarded(async () => asJson(await suggestFreshDomain())));

  server.registerTool("domain_usage", { title: "Example-domain usage", description: "Which example domains have been used, and in which chapters.", inputSchema: {} },
    guarded(async () => asJson(await domainUsage())));

  server.registerTool("reconcile", { title: "Reconcile bucket with history", description: "List the documents in Firebase Storage and diff against history: tracked docs, UNTRACKED docs needing ingestion, entries dropped because their object is gone, and duplicate resolutions.", inputSchema: {} },
    guarded(async () => asJson(await reconcile(getActiveProfile().deliverables))));

  server.registerTool("list_documents", { title: "List tracked documents", description: "Current history: one canonical entry per document, with its known content.", inputSchema: {} },
    guarded(async () => asJson(await listEntries())));

  server.registerTool("create_upload_url", { title: "Create document upload URL", description: "Get a short-lived signed URL to upload a generated .docx to the bucket. Upload with an HTTP PUT, Content-Type application/vnd.openxmlformats-officedocument.wordprocessingml.document. relPath is like 'chapitre_05/Manuel - Chapitre 5.docx'. After uploading, call log_generation with the same relPath.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson(await getStorageAdapter().createUploadUrl(a.relPath))));

  server.registerTool("create_download_url", { title: "Create document download URL", description: "Get a short-lived signed URL to download an EXISTING .docx from the bucket with an HTTP GET (no auth header needed). relPath is documents-relative, like 'chapitre_05/Manuel - Chapitre 5.docx' — the same path used by create_upload_url and get_document_text. Use this to fetch the original binary file (with its images and formatting intact) so you can edit it and re-upload via create_upload_url. Returns { url, objectKey, expiresAt, exists }; exists is false when there is no such object.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson(await getStorageAdapter().createDownloadUrl(a.relPath))));

  server.registerTool("get_document_text", { title: "Get document text", description: "Extract the plain text of a document in the bucket (by its documents-relative path) so you can read an UNTRACKED document and then record its content. When identifying characters, read the WHOLE document — characters appear in the opening scene AND in the activities and bilan, not only the amorce.", inputSchema: { relPath: z.string() } },
    guarded(async (a: { relPath: string }) => asJson({ relPath: a.relPath, text: await extractDocxText(a.relPath) })));

  server.registerTool("record_document_content", { title: "Record parsed document content", description: "After reading an UNTRACKED document's text, store the structured content you extracted into history so it is never re-parsed. For characters, include every one found ANYWHERE in the document (opening scene and activities/bilan), each with details like {name, type}. The object must already be in the bucket. 'type' is a deliverable key for the active subject (maths: 'manual' or 'lessons').", inputSchema: { chapter: z.number().int(), type: z.string(), relPath: z.string(), content: z.object(contentSchema) } },
    guarded(async (a: { chapter: number; type: string; relPath: string; content: any }) => badDeliverable(a.type) ?? asJson(await recordContent("parsed", a))));

  server.registerTool("log_generation", { title: "Log a generated document", description: "Call after uploading a generated .docx to the bucket (via create_upload_url). Reads the object's hash from storage and records what you produced so it feeds future consistency + variety. Log each character with details like {name, type} (e.g. {name:'Awa', type:'child'}), not just the name. No local file needed. 'type' is a deliverable key for the active subject (maths: 'manual' or 'lessons').", inputSchema: { chapter: z.number().int(), type: z.string(), relPath: z.string(), content: z.object(contentSchema) } },
    guarded(async (a: { chapter: number; type: string; relPath: string; content: any }) => badDeliverable(a.type) ?? asJson(await recordContent("pipeline", a))));

  return server;
}
