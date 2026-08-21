/*
 * Module: server · tool group: glossary (add_terms / edit_term / remove_terms)
 *
 * Curator loop over the workspace's bilingual lexicon. Each tool rides the shared
 * two-phase mutation framework (dry-run → confirmationToken → confirm) and, on a
 * successful confirm, AUTO-PUBLISHES the glossary draft — exactly like
 * add_to_catalog. Because they publish, they are APPROVER-gated (publishing is an
 * approver right); the whole flow is gated up front in stageAndPublish so a
 * curator gets an honest refusal rather than a staged-then-discarded draft.
 *
 * The glossary namespace self-seeds on first use: an empty published slot + a
 * pointer are stamped before the first mutation so a fresh workspace can grow a
 * lexicon with no seed script. That seed is gated behind the same authorization
 * as the mutation, so an unauthorized caller can never create the namespace.
 *
 * Reads (get_terminology, translate) resolve from the PUBLISHED lexicon via
 * server/glossary-read.ts; this file is the write path only.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { activeWorkspace } from "../context/index.js";
import { currentActor } from "../actor.js";
import { authorize } from "../authz.js";
import {
  getKgStore, mintNodeId, runGraphMutation, publishDraft, discardDraft,
  type GraphMutation, type StoredMeta,
} from "../kg-store/index.js";
import {
  glossaryNamespace, addTerms, editTerm, removeTerms,
  type AddTermsArgs, type EditTermArgs, type RemoveTermsArgs, type LexiconEntryInput,
} from "../glossary/index.js";

// Stamp an empty published slot + pointer so the very first mutation has a base
// to stage a draft on. Idempotent (no-op once a pointer exists). Only reached
// for an authorized caller — see stageAndPublish.
async function ensureGlossaryNamespace(namespace: string): Promise<void> {
  const store = getKgStore();
  if (await store.readPointer(namespace)) return;
  const meta: StoredMeta = {
    contentHash: "",
    seededAt: new Date().toISOString(),
    adapterId: "glossary/lexicon-v1",
    nodeCount: 0,
    edgeCount: 0,
  };
  await store.writeSlot(namespace, "a", { nodes: [], edges: [], meta });
  await store.ensurePointer(namespace, "a");
}

// Run a glossary mutation through the two-phase framework, then publish on a
// successful confirm (discarding the draft if the publish fails).
async function stageAndPublish<A>(
  namespace: string,
  mutation: GraphMutation<A>,
  args: A,
  confirm: boolean | undefined,
  token: string | undefined,
): Promise<unknown> {
  // These tools ALWAYS auto-publish, so they need the publish role (approver),
  // not just apply (curator) — gate the whole flow up front. Refusing here (vs
  // applying then failing at publish) gives a curator an honest "needs approver"
  // message AND keeps the auto-seed from running for a caller who can't finish.
  const authz = authorize(currentActor(), "publish", namespace);
  if (!authz.ok) return { phase: "unauthorized", kind: "graphMutation", action: "publish", reason: authz.reason };

  await ensureGlossaryNamespace(namespace);
  const result = await runGraphMutation({ namespace, mutation, args, confirm, token });
  if (confirm && result.phase === "apply" && result.ok) {
    const published = await publishDraft(namespace);
    if (!published.ok) {
      await discardDraft(namespace).catch(() => undefined);
      return { ...result, published: false, message: `Applied to the glossary draft but publishing failed (${published.reason}); the draft was discarded — retry.` };
    }
    return { ...result, published: true };
  }
  return result;
}

// One entry as the tool receives it (no id — ids are minted server-side).
type TermInput = {
  renderings: Record<string, string>;
  subject?: string;
  grade?: string;
  example?: string;
  tags?: string[];
  notes?: string;
};

// add_terms core, exported so tests drive the real logic. Mints one id per entry
// on the dry-run and reuses the caller's echoed ids on confirm, so both phases
// hash to the same args and build the identical nodes.
export async function runAddTerms(a: {
  entries?: TermInput[];
  mintedNodeIds?: string[];
  confirm?: boolean;
  confirmationToken?: string;
}): Promise<unknown> {
  const namespace = glossaryNamespace(activeWorkspace());
  const entries = a.entries ?? [];
  const ids = a.confirm ? (a.mintedNodeIds ?? []) : entries.map(() => mintNodeId());
  const built: AddTermsArgs["entries"] = entries.map((entry, index) => ({ ...entry, newNodeId: ids[index] ?? "" }));

  const result = await stageAndPublish(namespace, addTerms, { namespace, entries: built }, a.confirm, a.confirmationToken);
  // Surface the minted ids on the preview so the caller can echo them on confirm.
  if (!a.confirm && result && typeof result === "object" && (result as { phase?: string }).phase === "preview") {
    return { ...(result as object), mintedNodeIds: ids };
  }
  return result;
}

// edit_term core. The patch carries only the fields the caller supplied (undefined
// dropped) so the args hash is stable across dry-run and confirm.
export async function runEditTerm(a: {
  id: string;
  renderings?: Record<string, string>;
  subject?: string;
  grade?: string;
  example?: string;
  tags?: string[];
  notes?: string;
  confirm?: boolean;
  confirmationToken?: string;
}): Promise<unknown> {
  const namespace = glossaryNamespace(activeWorkspace());
  const candidate: Partial<LexiconEntryInput> = {
    renderings: a.renderings, subject: a.subject, grade: a.grade, example: a.example, tags: a.tags, notes: a.notes,
  };
  const patch = Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined)) as Partial<LexiconEntryInput>;
  const args: EditTermArgs = { namespace, id: a.id, patch };
  return stageAndPublish(namespace, editTerm, args, a.confirm, a.confirmationToken);
}

// remove_terms core.
export async function runRemoveTerms(a: {
  ids: string[];
  confirm?: boolean;
  confirmationToken?: string;
}): Promise<unknown> {
  const namespace = glossaryNamespace(activeWorkspace());
  const args: RemoveTermsArgs = { namespace, ids: a.ids };
  return stageAndPublish(namespace, removeTerms, args, a.confirm, a.confirmationToken);
}

export function registerGlossaryTools(server: McpServer) {
  server.registerTool(
    "add_terms",
    {
      title: "Add lexicon terms (one or many)",
      description:
        "Add ONE or MANY bilingual lexicon entries to the active WORKSPACE's glossary (shared across its grades/subjects — used for translation grounding and terminology lookup). Each `entries[i]` has `renderings` (a language-keyed map, e.g. { fr: 'compter', wo: 'waññ' } — at least one language), optional `subject`/`grade` to NARROW an entry to one context (omit for workspace-wide), and optional `example`/`tags`/`notes`. Entries may be single terms OR longer preferred phrases. Two-phase: the dry-run returns a diff + confirmationToken + `mintedNodeIds` (in item order); to confirm, call again with confirm:true, the token, the SAME `entries`, and `mintedNodeIds` echoed back. On a successful confirm the glossary is published automatically. Approver only (the confirm auto-publishes the lexicon).",
      inputSchema: {
        entries: z.array(
          z.object({
            renderings: z.record(z.string()),
            subject: z.string().optional(),
            grade: z.string().optional(),
            example: z.string().optional(),
            tags: z.array(z.string()).optional(),
            notes: z.string().optional(),
          }),
        ).optional(),
        mintedNodeIds: z.array(z.string()).optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { entries?: TermInput[]; mintedNodeIds?: string[]; confirm?: boolean; confirmationToken?: string }) =>
      asJson(await runAddTerms(a))),
  );

  server.registerTool(
    "edit_term",
    {
      title: "Edit a lexicon term",
      description:
        "Edit one glossary entry in place by `id` (get ids from add_terms or the graph). Supply only the fields to change: `renderings` MERGE key-by-key (a blank value drops that language; the edit cannot leave the entry with zero renderings), while `subject`/`grade`/`example`/`tags`/`notes` REPLACE (pass an empty string to clear one). Two-phase: dry-run returns a diff + confirmationToken; confirm with confirm:true, the token, and the same fields. Auto-publishes on confirm. Approver only (the confirm auto-publishes the lexicon).",
      inputSchema: {
        id: z.string(),
        renderings: z.record(z.string()).optional(),
        subject: z.string().optional(),
        grade: z.string().optional(),
        example: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: {
      id: string; renderings?: Record<string, string>; subject?: string; grade?: string;
      example?: string; tags?: string[]; notes?: string; confirm?: boolean; confirmationToken?: string;
    }) => asJson(await runEditTerm(a))),
  );

  server.registerTool(
    "remove_terms",
    {
      title: "Remove lexicon terms (one or many)",
      description:
        "Remove ONE or MANY glossary entries by `id` in one atomic edit. Two-phase: dry-run returns a diff + confirmationToken listing what will vanish; confirm with confirm:true and the token. Auto-publishes on confirm. Approver only (the confirm auto-publishes the lexicon).",
      inputSchema: {
        ids: z.array(z.string()),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { ids: string[]; confirm?: boolean; confirmationToken?: string }) =>
      asJson(await runRemoveTerms(a))),
  );
}
