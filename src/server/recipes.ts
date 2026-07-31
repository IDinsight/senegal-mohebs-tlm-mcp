// ── Module: server · tool group: curriculum recipes (#14) ───────────────────
// The five composite recipes — add_lesson, add_chapter, move_lesson,
// split_chapter, renumber — each a SINGLE #5 mutation exposed as an MCP tool.
// They share the exact envelope every graph edit uses (two-phase confirm,
// #13's integrity floor on the whole result, #7 audit, #8 role gate); what
// makes them "recipes" is that ONE confirm applies MANY create/link/unlink +
// structural-property edits atomically to the draft.
//
// Recipes are available only for a subject whose adapter declares a
// `recipeProfile` + `structuralAliases` (maths does; reading does not) — the
// tool returns a clear "not available" message otherwise, rather than guessing.
//
// id-minting mirrors create_node: recipes that CREATE nodes (add_lesson,
// add_chapter, split_chapter) mint the id(s) server-side on the dry-run and
// surface them at the response top level; the caller passes the SAME ids back
// on confirm so the framework's args-hash matches. add_chapter mints one
// chapter id + one id per seed lesson.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import {
  runGraphMutation, kgNamespace, mintNodeId,
  addLesson, addChapter, moveLesson, splitChapter, renumber,
} from "../kg-store/index.js";
import type { MutationGraph } from "../kg-store/index.js";
import type { SubjectAdapter, RecipeProfile, StructuralAliases, WordingAliases } from "../types.js";

// Resolve the subject vocabulary the recipes bind to, or an error payload if
// the active subject has no recipes. Every recipe tool calls this first.
type RecipeBinding = {
  namespace: string;
  profile: RecipeProfile;
  structuralAliases: StructuralAliases;
  wordingAliases: WordingAliases;
  coverage: (g: MutationGraph) => string[];
};
function bindRecipes(adapter: SubjectAdapter): RecipeBinding | { unavailable: string } {
  if (!adapter.recipeProfile || !adapter.structuralAliases) {
    return { unavailable: `Curriculum recipes are not available for ${adapter.grade}/${adapter.subject} — this subject's adapter declares no recipeProfile. Use the raw structural verbs (create_node/link_nodes/…) instead.` };
  }
  return {
    namespace: kgNamespace(adapter.grade, adapter.subject),
    profile: adapter.recipeProfile,
    structuralAliases: adapter.structuralAliases,
    wordingAliases: adapter.wordingAliases,
    coverage: (g) => adapter.coverageWarnings?.(g) ?? [],
  };
}

// On a dry-run preview, surface the minted id(s) at the top level so Claude can
// pass them back on confirm without fishing them out of the diff — mirrors
// create_node's `mintedNodeId`. No-op on confirm and on blocked/unauthorized.
function withMinted(result: unknown, minted: Record<string, unknown>): unknown {
  const r = result as { kind?: string; phase?: string };
  if (r && r.kind === "graphMutation" && r.phase === "preview") return { ...(result as object), ...minted };
  return result;
}

export function registerRecipeTools(server: McpServer) {
  // ── add_lesson ────────────────────────────────────────────────────────────
  server.registerTool(
    "add_lesson",
    {
      title: "Add a lesson to a chapter",
      description:
        "COMPOSITE recipe: create a new lesson node AND link it (hasChild) to an existing chapter, in ONE atomic draft edit. The lesson's chapter-membership number is set from the target chapter so it renders under it. Additive — linking to a nonexistent chapter is BLOCKED by referential integrity. `order` sets the within-chapter position (defaults to appending); `isBilan:true` marks it as the end-of-chapter assessment. REQUIRES CONFIRMATION: dry-run returns one whole-composite diff + confirmationToken + mintedLessonId; ask the user, then call again with confirm:true, the token, AND the same mintedLessonId. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        chapterId: z.string(),
        text: z.string(),
        text_en: z.string().optional(),
        order: z.number().optional(),
        isBilan: z.boolean().optional(),
        mintedLessonId: z.string().optional(),   // required on confirm
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { chapterId: string; text: string; text_en?: string; order?: number; isBilan?: boolean; mintedLessonId?: string; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const lessonId = a.confirm ? (a.mintedLessonId ?? "") : mintNodeId();
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: addLesson,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, chapterId: a.chapterId, lessonId, text: a.text, text_en: a.text_en, order: a.order, isBilan: a.isBilan },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(a.confirm ? result : withMinted(result, { mintedLessonId: lessonId }));
    }),
  );

  // ── add_chapter ───────────────────────────────────────────────────────────
  server.registerTool(
    "add_chapter",
    {
      title: "Add a chapter (optionally with lessons)",
      description:
        "COMPOSITE recipe: create a new chapter (title + number at BIRTH) and, optionally, seed lessons (each created and linked), all in ONE atomic draft edit. The number must be FREE — append after the last chapter or fill a gap; a colliding number is REJECTED (inserting between chapters and shifting the rest is renumber's job, not this additive path). `lessons` is an array of { text, text_en?, isBilan? }. REQUIRES CONFIRMATION: dry-run returns the whole-composite diff + confirmationToken + mintedChapterId + mintedLessonIds; call again with confirm:true, the token, and the SAME minted ids. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        number: z.number(),
        title: z.string(),
        title_en: z.string().optional(),
        lessons: z.array(z.object({ text: z.string(), text_en: z.string().optional(), isBilan: z.boolean().optional() })).optional(),
        mintedChapterId: z.string().optional(),
        mintedLessonIds: z.array(z.string()).optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { number: number; title: string; title_en?: string; lessons?: Array<{ text: string; text_en?: string; isBilan?: boolean }>; mintedChapterId?: string; mintedLessonIds?: string[]; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const seedCount = a.lessons?.length ?? 0;
      const chapterId = a.confirm ? (a.mintedChapterId ?? "") : mintNodeId();
      const lessonIds = a.confirm ? (a.mintedLessonIds ?? []) : Array.from({ length: seedCount }, () => mintNodeId());
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: addChapter,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, chapterId, number: a.number, title: a.title, title_en: a.title_en, lessons: a.lessons, lessonIds },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(a.confirm ? result : withMinted(result, { mintedChapterId: chapterId, mintedLessonIds: lessonIds }));
    }),
  );

  // ── move_lesson ───────────────────────────────────────────────────────────
  server.registerTool(
    "move_lesson",
    {
      title: "Move a lesson to another chapter",
      description:
        "COMPOSITE recipe: rehome a lesson from its current chapter to another — unlink the old hasChild edge, link the new one, AND rewrite the lesson's chapter-membership number so it renders under the new chapter — in ONE atomic draft edit. Referential integrity validates the whole result (no orphan, no dangling edge); coverage warnings surface if, say, the source chapter is left without a bilan. `position` sets the within-target order (defaults to appending). REQUIRES CONFIRMATION. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        lessonId: z.string(),
        toChapterId: z.string(),
        position: z.number().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { lessonId: string; toChapterId: string; position?: number; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: moveLesson,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, lessonId: a.lessonId, toChapterId: a.toChapterId, position: a.position },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(result);
    }),
  );

  // ── split_chapter ─────────────────────────────────────────────────────────
  server.registerTool(
    "split_chapter",
    {
      title: "Split a chapter into two",
      description:
        "COMPOSITE recipe: create a new chapter and MOVE the tail lessons (from `atLessonId` onward, in order) into it — unlink each old hasChild edge, link the new one, rewrite each moved lesson's chapter-membership number — in ONE atomic draft edit. The new chapter is APPENDED at the next free number by default (no existing chapter is shifted); pass a free `newNumber` to place it in a gap. The whole result is integrity-checked; a split that leaves either chapter without a bilan WARNS (never blocks). REQUIRES CONFIRMATION: dry-run returns the whole-composite diff + confirmationToken + mintedChapterId; confirm with the same minted id. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        chapterId: z.string(),
        atLessonId: z.string(),
        newTitle: z.string().optional(),
        newTitle_en: z.string().optional(),
        newNumber: z.number().optional(),
        mintedChapterId: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { chapterId: string; atLessonId: string; newTitle?: string; newTitle_en?: string; newNumber?: number; mintedChapterId?: string; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const newChapterId = a.confirm ? (a.mintedChapterId ?? "") : mintNodeId();
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: splitChapter,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, chapterId: a.chapterId, atLessonId: a.atLessonId, newChapterId, newTitle: a.newTitle, newTitle_en: a.newTitle_en, newNumber: a.newNumber },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(a.confirm ? result : withMinted(result, { mintedChapterId: newChapterId }));
    }),
  );

  // ── renumber ──────────────────────────────────────────────────────────────
  server.registerTool(
    "renumber",
    {
      title: "Renumber a chapter",
      description:
        "COMPOSITE recipe (the regime-gated one): change a chapter's number AND cascade-rewrite every child lesson's chapter-membership number in ONE atomic draft edit, so the whole family stays consistent and nothing drifts. The target number must be FREE — renumber MOVES a chapter to an unoccupied number; moving into an occupied slot (insert-with-shift or swap) is a separate, explicit operation and is rejected here. REQUIRES CONFIRMATION. DRAFT edit — publish_draft to make it live. (Under this codebase's reference regime, a maths chapter's number is a denormalized presentation join key, so leaving lessons un-rewritten would misfile them — this recipe rewrites the whole family to prevent exactly that.)",
      inputSchema: {
        chapterId: z.string(),
        newNumber: z.number(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { chapterId: string; newNumber: number; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: renumber,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, chapterId: a.chapterId, newNumber: a.newNumber },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(result);
    }),
  );
}
