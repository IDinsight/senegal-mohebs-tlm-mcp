// ── Module: server · tool group: curriculum recipes (#14) ───────────────────
// The five composite recipes — add_lesson, add_lesson_grouping, move_lesson,
// split_lesson_grouping, renumber — each a SINGLE #5 mutation exposed as an MCP tool.
// They share the exact envelope every graph edit uses (two-phase confirm,
// #13's integrity floor on the whole result, #7 audit, #8 role gate); what
// makes them "recipes" is that ONE confirm applies MANY create/link/unlink +
// structural-property edits atomically to the draft.
//
// Recipes are available only for a subject whose adapter declares a
// `recipeProfile` + `structuralAliases` (CI CI maths does; CE1 CE1 reading does not) — the
// tool returns a clear "not available" message otherwise, rather than guessing.
//
// id-minting mirrors create_node: recipes that CREATE nodes (add_lesson,
// add_lesson_grouping, split_lesson_grouping) mint the id(s) server-side on the dry-run and
// surface them at the response top level; the caller passes the SAME ids back
// on confirm so the framework's args-hash matches. add_lesson_grouping mints one
// chapter id + one id per seed lesson.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import {
  runGraphMutation, kgNamespace, mintNodeId,
  addLesson, addLessonGrouping, moveLesson, splitLessonGrouping, renumber,
} from "../kg-store/index.js";
import type { MutationGraph } from "../kg-store/index.js";
import type { SubjectAdapter, RecipeProfile, StructuralAliases, WordingAliases, LcNodeTemplate } from "../types.js";

// Resolve the subject vocabulary the recipes bind to, or an error payload if
// the active subject has no recipes. Every recipe tool calls this first.
type RecipeBinding = {
  namespace: string;
  profile: RecipeProfile;
  structuralAliases: StructuralAliases;
  wordingAliases: WordingAliases;
  lcNodeTemplate?: LcNodeTemplate;
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
    lcNodeTemplate: adapter.lcNodeTemplate,
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
        "COMPOSITE recipe: create a new lesson node, link it (hasChild) to an existing chapter, AND align it (supports) to an existing spine expectation (the objectif spécifique it teaches) — in ONE atomic draft edit. `text` is the lesson's own title (the OS text lives on the expectation, edited separately). Additive — a nonexistent chapter OR expectation is BLOCKED by referential integrity; the standard must already exist (author it upstream). `order` sets the within-chapter position (defaults to appending); `isBilan:true` marks it as the end-of-chapter assessment. REQUIRES CONFIRMATION: dry-run returns one whole-composite diff + confirmationToken + mintedLessonId; ask the user, then call again with confirm:true, the token, AND the same mintedLessonId. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        groupingId: z.string(),
        expectationId: z.string(),
        text: z.string(),
        text_en: z.string().optional(),
        order: z.number().optional(),
        isBilan: z.boolean().optional(),
        mintedLessonId: z.string().optional(),   // required on confirm
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { groupingId: string; expectationId: string; text: string; text_en?: string; order?: number; isBilan?: boolean; mintedLessonId?: string; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const lessonId = a.confirm ? (a.mintedLessonId ?? "") : mintNodeId();
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: addLesson,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, lcNodeTemplate: bind.lcNodeTemplate, groupingId: a.groupingId, expectationId: a.expectationId, lessonId, text: a.text, text_en: a.text_en, order: a.order, isBilan: a.isBilan },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(a.confirm ? result : withMinted(result, { mintedLessonId: lessonId }));
    }),
  );

  // ── add_lesson_grouping ─────────────────────────────────────────────────────
  server.registerTool(
    "add_lesson_grouping",
    {
      title: "Add a lesson grouping (chapter / unit / module)",
      description:
        "COMPOSITE recipe: create a new lesson grouping — an LC LessonGrouping, the generic container whose naming varies by publisher (Chapitre, Unité, Module…) — in ONE atomic draft edit. `groupName` is the grouping TYPE (defaults to \"Chapitre\"); `number` is its position in the series and must be FREE — append after the last grouping or fill a gap; a colliding number is REJECTED (inserting between groupings and shifting the rest is renumber's job). The grouping is created EMPTY; add lessons afterward with add_lesson (each aligned to an existing standard). REQUIRES CONFIRMATION: dry-run returns the whole-composite diff + confirmationToken + mintedGroupingId; call again with confirm:true, the token, and the SAME minted id. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        number: z.number(),
        title: z.string(),
        title_en: z.string().optional(),
        groupName: z.string().optional(),
        mintedGroupingId: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { number: number; title: string; title_en?: string; groupName?: string; mintedGroupingId?: string; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const groupingId = a.confirm ? (a.mintedGroupingId ?? "") : mintNodeId();
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: addLessonGrouping,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, lcNodeTemplate: bind.lcNodeTemplate, groupingId, number: a.number, title: a.title, title_en: a.title_en, groupName: a.groupName },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(a.confirm ? result : withMinted(result, { mintedGroupingId: groupingId }));
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
        toGroupingId: z.string(),
        position: z.number().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { lessonId: string; toGroupingId: string; position?: number; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: moveLesson,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, lessonId: a.lessonId, toGroupingId: a.toGroupingId, position: a.position },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(result);
    }),
  );

  // ── split_lesson_grouping ─────────────────────────────────────────────────────────
  server.registerTool(
    "split_lesson_grouping",
    {
      title: "Split a lesson grouping into two",
      description:
        "COMPOSITE recipe: create a new lesson grouping (same type as the source — Chapitre/Unité/Module) and MOVE the tail lessons (from `atLessonId` onward, in order) into it — unlink each old hasChild edge, link the new one — in ONE atomic draft edit. The new grouping is APPENDED at the next free number by default (no existing grouping is shifted); pass a free `newNumber` to place it in a gap. The whole result is integrity-checked; a split that leaves either grouping without a bilan WARNS (never blocks). `groupingId` is the grouping being split. REQUIRES CONFIRMATION: dry-run returns the whole-composite diff + confirmationToken + mintedGroupingId; confirm with the same minted id. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        groupingId: z.string(),
        atLessonId: z.string(),
        newTitle: z.string().optional(),
        newTitle_en: z.string().optional(),
        newNumber: z.number().optional(),
        mintedGroupingId: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { groupingId: string; atLessonId: string; newTitle?: string; newTitle_en?: string; newNumber?: number; mintedGroupingId?: string; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const newGroupingId = a.confirm ? (a.mintedGroupingId ?? "") : mintNodeId();
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: splitLessonGrouping,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, lcNodeTemplate: bind.lcNodeTemplate, groupingId: a.groupingId, atLessonId: a.atLessonId, newGroupingId, newTitle: a.newTitle, newTitle_en: a.newTitle_en, newNumber: a.newNumber },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(a.confirm ? result : withMinted(result, { mintedGroupingId: newGroupingId }));
    }),
  );

  // ── renumber ──────────────────────────────────────────────────────────────
  server.registerTool(
    "renumber",
    {
      title: "Renumber a chapter",
      description:
        "COMPOSITE recipe (the regime-gated one): change a chapter's number AND cascade-rewrite every child lesson's chapter-membership number in ONE atomic draft edit, so the whole family stays consistent and nothing drifts. The target number must be FREE — renumber MOVES a chapter to an unoccupied number; moving into an occupied slot (insert-with-shift or swap) is a separate, explicit operation and is rejected here. REQUIRES CONFIRMATION. DRAFT edit — publish_draft to make it live. (Under this codebase's reference regime, a CI maths chapter's number is a denormalized presentation join key, so leaving lessons un-rewritten would misfile them — this recipe rewrites the whole family to prevent exactly that.)",
      inputSchema: {
        groupingId: z.string(),
        newNumber: z.number(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { groupingId: string; newNumber: number; confirm?: boolean; confirmationToken?: string }) => {
      const bind = bindRecipes(getActiveAdapter());
      if ("unavailable" in bind) return asJson({ phase: "blocked", kind: "graphMutation", errors: [bind.unavailable], warnings: [] });
      const result = await runGraphMutation({
        namespace: bind.namespace,
        mutation: renumber,
        args: { namespace: bind.namespace, profile: bind.profile, structuralAliases: bind.structuralAliases, wordingAliases: bind.wordingAliases, groupingId: a.groupingId, newNumber: a.newNumber },
        confirm: a.confirm,
        token: a.confirmationToken,
        coverage: bind.coverage,
      });
      return asJson(result);
    }),
  );
}
