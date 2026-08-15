/*
 * Module: server · tool group: preview generation (draft-resolved)
 *
 * Closes the editing loop: the #5 dry-run shows the DIFF a staged edit makes to
 * the graph; preview_generation shows the RESULT — the teaching material that
 * same edit would yield — by resolving the curriculum from the DRAFT slot
 * instead of published, and running the SAME generation flow on it.
 *
 * ISOLATION is the whole point. A preview:
 *   • reads the DRAFT (unpublished) — it does NOT mutate the graph;
 *   • NEVER reads or writes published;
 *   • its .docx output goes to a SEGREGATED previews/ prefix (not the canonical
 *     documents/ bucket), via short-lived, clearly-labelled signed URLs, and is
 *     NEVER recorded through log_generation / list_documents / history;
 *   • is role-gated to the same trust tier as diff_draft (curator + approver;
 *     unknown/no-role blocked + audited), because a draft is pre-publish WIP.
 *
 * What is REUSED (not rebuilt): the exact draft slot diff_draft reads (pointer
 * .draftSlot → listNodes/listEdges), the store-bridge deserializeToModel (#3),
 * and the subject adapter's own buildGenerationContext — which now accepts a
 * pre-resolved model so the published read path stays byte-identical.
 *
 * The tool bodies delegate to the exported cores below (previewGeneration /
 * createPreviewUploadUrl) so tests can drive the real logic directly, the same
 * way capabilities.ts exposes buildCapabilitiesReport.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { getKgStore, kgNamespace, toAuditActor } from "../kg-store/index.js";
import { toRawEnvelope, courseSubgraph } from "../curriculum/index.js";
import { getStorageAdapter } from "../storage/index.js";
import { authorize } from "../authz.js";
import { currentActor } from "../actor.js";
import { kgSource } from "../config.js";
import type { CurriculumModel } from "../types.js";

// The single, fixed label every preview surface carries so the material can
// never be mistaken for a published deliverable.
export const PREVIEW_LABEL = "PREVIEW — generated from an unpublished draft, not a published deliverable";

// Resolve the curriculum from the DRAFT slot — the same slot diff_draft reads —
// or null when there is no draft to preview. Draft/published slots only exist
// in KG_SOURCE=firestore mode; in bundle mode there is no draft concept, so we
// return null (→ the caller surfaces the clear "no draft" notice). The
// deserialize step is the same store-bridge path activate.ts uses for published.
export async function resolveDraftModel(
  ns: string,
): Promise<{ model: CurriculumModel; draftSlot: string; draftVersion: string | null } | null> {
  if (kgSource() !== "firestore") return null;
  const store = getKgStore();
  const pointer = await store.readPointer(ns);
  if (!pointer || !pointer.draftSlot) return null;
  const [nodes, edges, meta] = await Promise.all([
    store.listNodes(ns, pointer.draftSlot),
    store.listEdges(ns, pointer.draftSlot),
    store.readMeta(ns, pointer.draftSlot),
  ]);
  return {
    // Same full-graph hydration as activate.ts: rebuild the LC envelope from the
    // draft slot and run the active adapter's parser to derive the spine model.
    model: getActiveAdapter().parse(toRawEnvelope({ nodes, edges })),
    draftSlot: pointer.draftSlot,
    draftVersion: meta?.contentHash ?? null,
  };
}

// Shared role gate for the preview surface. Same tier as diff_draft's readDraft:
// curator + approver may preview; unknown/no-role is blocked and audited (never
// leaks draft content). Returns the unauthorized payload when denied, or null
// when allowed. Not a mutation → no token, no two-phase confirm.
async function denyIfNotDraftReader(ns: string): Promise<Record<string, unknown> | null> {
  const actor = currentActor();
  const authz = authorize(actor, "readDraft", ns);
  if (authz.ok) return null;
  await getKgStore().appendAudit({
    id: randomUUID(),
    ts: new Date().toISOString(),
    actor: toAuditActor(actor),
    namespace: ns,
    eventType: "blocked",
    reason: `unauthorized: ${authz.reason}`,
  });
  return { phase: "unauthorized", preview: true, action: "readDraft", reason: authz.reason };
}

// ── Core: preview_generation ─────────────────────────────────────────────────
// The draft-resolved course-subtree read (what walk_graph over hasPart/hasChild
// returns, but from the DRAFT model), tagged as a preview. Reads only; no graph
// write. Exported so tests drive the real logic.
export async function previewGeneration(course: string): Promise<Record<string, unknown>> {
  const adapter = getActiveAdapter();
  const ns = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

  const denied = await denyIfNotDraftReader(ns);
  if (denied) return denied;

  const resolved = await resolveDraftModel(ns);
  if (!resolved) {
    return {
      preview: true,
      noDraft: true,
      message:
        `No draft exists for '${ns}' to preview. A preview reflects UNPUBLISHED draft edits, so with no draft there is nothing to preview. ` +
        `Stage an edit first (add_node / set_content / reposition / …), then call preview_generation again.`,
    };
  }

  // Read the SAME course subtree walk_graph returns, but from the draft-resolved
  // model — so the curator sees the graph a staged edit would generate from. The
  // standards spine (get_standards) resolves against published as usual.
  const sub = courseSubgraph(resolved.model, course);
  if (!sub) {
    return { preview: true, error: `Course '${course}' not found in the draft. Call namespace_stats (its roots) for available course ids.` };
  }

  // Audit a PREVIEW event — distinct from apply/publish/generation, and never
  // recorded via log_generation. It documents who read unpublished draft content
  // to preview it, without masquerading as a real deliverable.
  await getKgStore().appendAudit({
    id: randomUUID(),
    ts: new Date().toISOString(),
    actor: toAuditActor(currentActor()),
    namespace: ns,
    eventType: "preview",
    reason: `preview generation for course '${course}' from draft${resolved.draftVersion ? ` ${resolved.draftVersion}` : ""}`,
  });

  return {
    preview: true,
    label: PREVIEW_LABEL,
    isolation:
      "This course subtree was resolved from the UNPUBLISHED draft. Generate the .docx from it, then surface the result via create_preview_upload_url. Do NOT call log_generation or create_upload_url with a preview — those write to the canonical documents bucket and history and would break the isolation.",
    draftVersion: resolved.draftVersion,
    ...sub,
  };
}

// ── Core: create_preview_upload_url ──────────────────────────────────────────
// The preview output path. Mints a short-lived write+read URL pair for a
// throwaway .docx under the SIBLING previews/ prefix — never the canonical
// documents/ keyspace, never logged to history. No confirmation: it is not a
// canonical write, it auto-expires, and it is part of the read-like preview
// flow. Role-gated to the same tier as previewGeneration.
export async function createPreviewUploadUrl(relPath: string): Promise<Record<string, unknown>> {
  const adapter = getActiveAdapter();
  const ns = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

  const denied = await denyIfNotDraftReader(ns);
  if (denied) return denied;

  const storage = getStorageAdapter();
  if (!storage.createPreviewUpload) {
    return { preview: true, error: "The active storage backend does not support preview uploads." };
  }
  const signed = await storage.createPreviewUpload(relPath);
  return {
    preview: true,
    label: PREVIEW_LABEL,
    ...signed,
    note:
      "PUT the generated .docx to uploadUrl, then hand the human downloadUrl. This object is under previews/ (segregated from the canonical documents bucket) — it will NOT appear in list_documents/reconcile and must NEVER be recorded via log_generation. It expires at expiresAt.",
  };
}

export function registerPreviewTools(server: McpServer) {
  server.registerTool(
    "preview_generation",
    {
      title: "Preview generation from the draft",
      description:
        "Return the containment subtree under one Course resolved from the UNPUBLISHED DRAFT (not published) — the draft-resolved course-subtree read (walk_graph reads the published graph; this reads the draft) — so you can generate a PREVIEW of the teaching material a staged edit would produce, before publishing. This closes the editing loop: dry-run shows the graph DIFF, preview shows the resulting MATERIAL. Read-only on the draft (no graph change). Curators and approvers only. If no draft exists, returns a clear 'no draft to preview' notice. 'course' is a Course id (from namespace_stats roots). IMPORTANT: the returned subtree is a PREVIEW — generate the .docx from it, then surface it via create_preview_upload_url (segregated, short-lived, non-canonical). NEVER log_generation or create_upload_url a preview: those write to the canonical bucket/history and would defeat the isolation.",
      inputSchema: { course: z.string() },
    },
    guarded(async (a: { course: string }) => asJson(await previewGeneration(a.course))),
  );

  server.registerTool(
    "create_preview_upload_url",
    {
      title: "Create preview upload URL",
      description:
        "Get short-lived signed URLs to upload and read a PREVIEW .docx generated from a draft (via preview_generation). Returns { uploadUrl, downloadUrl, objectKey, expiresAt, label }. Upload the .docx to uploadUrl with an HTTP PUT (Content-Type application/vnd.openxmlformats-officedocument.wordprocessingml.document), then hand the human downloadUrl to open it. relPath is like 'chapitre_05/Manuel - Chapitre 5.docx'. The object lives under a SEGREGATED previews/ prefix: it is NOT in the canonical documents bucket, NEVER appears in list_documents or reconcile, and is NEVER logged via log_generation. It expires quickly. Curators and approvers only. Do NOT call log_generation for a preview.",
      inputSchema: { relPath: z.string() },
    },
    guarded(async (a: { relPath: string }) => asJson(await createPreviewUploadUrl(a.relPath))),
  );
}
