/*
 * Module: server · tool group: typed authoring (LC-grounded)
 *
 * One tool per Learning-Commons node type. Each is a thin TYPED FACADE over the
 * single internal `addNode` recipe: it fixes the LC `label`, bakes in the
 * canonical containment edge (hasPart for content, hasChild for standards,
 * `supports` for a LearningComponent — resolved inside addNode), maps a few
 * author-facing params to the node's canonical LC properties, and (for content
 * nodes) optionally aligns to a standard via `alignTo` (hasEducationalAlignment).
 *
 * The ~10 machine boilerplate props (license, provider, attributionStatement,
 * academicSubject, gradeLevel, inLanguage, jurisdiction, identifier) are NOT
 * author-facing: addNode copies them from an existing node of the same label, so
 * a created node looks exactly like a seeded one (kg-recipes/lc.ts).
 *
 * Every tool shares the graph-mutation envelope: a dry-run returns a diff +
 * confirmationToken + mintedNodeId (no state change); the confirm re-checks the
 * token and applies to the DRAFT only. Publish_draft makes it live. See
 * docs/design-notes/typed-authoring-tools.md.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { runGraphMutation, kgNamespace, mintNodeId, type MutationGraph } from "../kg-store/index.js";
import { addNode } from "../kg-recipes/index.js";
import type { SubjectAdapter } from "../types.js";

// Namespace + coverage hook the active subject binds to (same as the other
// mutation tool groups).
function bind(adapter: SubjectAdapter): { namespace: string; coverage: (g: MutationGraph) => string[] } {
  return {
    namespace: kgNamespace(activeWorkspace(), adapter.grade, adapter.subject),
    coverage: (g) => adapter.coverageWarnings?.(g as never) ?? [],
  };
}

// Surface the minted id at the top level of a dry-run preview so the caller can
// pass it back on confirm. No-op on confirm / blocked / unauthorized results.
function withMinted(result: unknown, mintedNodeId: string): unknown {
  const r = result as { kind?: string; phase?: string };
  if (r && r.kind === "graphMutation" && r.phase === "preview") return { ...(result as object), mintedNodeId };
  return result;
}

// The fields every typed add shares.
type AddCommon = {
  description?: string;   // the node's display text (→ title/text + raw.description)
  title_en?: string;      // English mirror (→ raw.metadata.en.description)
  position?: number;      // within-parent order; defaults to appending
  alignTo?: string;       // an SFI id to align to (hasEducationalAlignment)
  mintedNodeId?: string;  // required on confirm
  confirm?: boolean;
  confirmationToken?: string;
};

// The one shared path: run the internal addNode recipe for a fixed LC `label`,
// with `properties` carrying the type-specific canonical LC props (→ raw.*).
async function runTypedAdd(
  label: string,
  a: AddCommon & { parentId?: string; properties?: Record<string, unknown> },
) {
  const { namespace, coverage } = bind(getActiveAdapter());
  const newNodeId = a.confirm ? (a.mintedNodeId ?? "") : mintNodeId();
  const result = await runGraphMutation({
    namespace,
    mutation: addNode,
    args: {
      namespace, parentId: a.parentId, label, newNodeId,
      title: a.description, title_en: a.title_en, position: a.position,
      alignTo: a.alignTo, properties: a.properties,
    },
    confirm: a.confirm,
    token: a.confirmationToken,
    coverage,
  });
  return asJson(a.confirm ? result : withMinted(result, newNodeId));
}

// Shared confirm-gate input fields (declared on every tool's schema).
const CONFIRM = {
  mintedNodeId: z.string().optional(),   // required on confirm
  confirm: z.boolean().optional(),
  confirmationToken: z.string().optional(),
};

export function registerAuthoringTools(server: McpServer) {
  // ── add_course ────────────────────────────────────────────────────────────
  server.registerTool(
    "add_course",
    {
      title: "Add a Course",
      description:
        "Create an LC `Course` — a top-level CONTENT ROOT (no parent; e.g. a pupil book or a teacher guide). LC props: `audience` (1..n, who it is for — Student/Teacher), `description` (title), `educationalUse`, `courseCode`, `timeRequired`. Boilerplate (license/provider/academicSubject/…) is copied from an existing Course. REQUIRES CONFIRMATION: dry-run returns diff + confirmationToken + mintedNodeId; call again with confirm:true, the token, and the same mintedNodeId. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        description: z.string().optional(),
        title_en: z.string().optional(),
        audience: z.array(z.string()).optional(),
        educationalUse: z.string().optional(),
        courseCode: z.string().optional(),
        timeRequired: z.string().optional(),
        ...CONFIRM,
      },
    },
    guarded(async (a: AddCommon & { audience?: string[]; educationalUse?: string; courseCode?: string; timeRequired?: string }) =>
      runTypedAdd("Course", { ...a, properties: { audience: a.audience, educationalUse: a.educationalUse, courseCode: a.courseCode, timeRequired: a.timeRequired } }),
    ),
  );

  // ── add_lesson_grouping ─────────────────────────────────────────────────────
  server.registerTool(
    "add_lesson_grouping",
    {
      title: "Add a LessonGrouping",
      description:
        "Create an LC `LessonGrouping` (a chapter / unit / week) under `parentId` (a Course or another LessonGrouping) via `hasPart`. LC props: `groupName` (the kind of grouping — e.g. 'Chapitre', 'Unité', 'Semaine'; required), `groupLevel` (nesting depth, required), `audience`, `description` (title), `position`, `educationalUse`. Optional `alignTo` (SFI → hasEducationalAlignment). REQUIRES CONFIRMATION (dry-run → confirmationToken + mintedNodeId). DRAFT edit.",
      inputSchema: {
        parentId: z.string(),
        description: z.string().optional(),
        title_en: z.string().optional(),
        groupName: z.string().optional(),
        groupLevel: z.number().int().optional(),
        audience: z.array(z.string()).optional(),
        educationalUse: z.string().optional(),
        position: z.number().optional(),
        alignTo: z.string().optional(),
        ...CONFIRM,
      },
    },
    guarded(async (a: AddCommon & { parentId: string; groupName?: string; groupLevel?: number; audience?: string[]; educationalUse?: string }) =>
      runTypedAdd("LessonGrouping", { ...a, properties: { groupName: a.groupName, groupLevel: a.groupLevel, audience: a.audience, educationalUse: a.educationalUse } }),
    ),
  );

  // ── add_lesson ──────────────────────────────────────────────────────────────
  server.registerTool(
    "add_lesson",
    {
      title: "Add a Lesson",
      description:
        "Create an LC `Lesson` under `parentId` (a LessonGrouping) via `hasPart`. LC props: `audience` (1..n), `description` (title), `position`, `educationalUse` (set 'Assessment' to mark it a bilan / end assessment), `timeRequired`. Optional `alignTo` — the StandardsFrameworkItem this lesson TEACHES (hasEducationalAlignment); a lesson with no alignment floats free. REQUIRES CONFIRMATION (dry-run → confirmationToken + mintedNodeId). DRAFT edit.",
      inputSchema: {
        parentId: z.string(),
        description: z.string().optional(),
        title_en: z.string().optional(),
        audience: z.array(z.string()).optional(),
        educationalUse: z.string().optional(),
        timeRequired: z.string().optional(),
        position: z.number().optional(),
        alignTo: z.string().optional(),
        ...CONFIRM,
      },
    },
    guarded(async (a: AddCommon & { parentId: string; audience?: string[]; educationalUse?: string; timeRequired?: string }) =>
      runTypedAdd("Lesson", { ...a, properties: { audience: a.audience, educationalUse: a.educationalUse, timeRequired: a.timeRequired } }),
    ),
  );

  // ── add_activity ─────────────────────────────────────────────────────────────
  server.registerTool(
    "add_activity",
    {
      title: "Add an Activity",
      description:
        "Create an LC `Activity` under `parentId` (a Lesson) via `hasPart`. LC props: `audience` (1..n), `description` (title), `position`, `studentGroupingType` (how students work — Individual/Pairs/Group), `timeRequired`. Optional `alignTo` — the StandardsFrameworkItem this activity exercises (hasEducationalAlignment). REQUIRES CONFIRMATION (dry-run → confirmationToken + mintedNodeId). DRAFT edit.",
      inputSchema: {
        parentId: z.string(),
        description: z.string().optional(),
        title_en: z.string().optional(),
        audience: z.array(z.string()).optional(),
        studentGroupingType: z.string().optional(),
        timeRequired: z.string().optional(),
        position: z.number().optional(),
        alignTo: z.string().optional(),
        ...CONFIRM,
      },
    },
    guarded(async (a: AddCommon & { parentId: string; audience?: string[]; studentGroupingType?: string; timeRequired?: string }) =>
      runTypedAdd("Activity", { ...a, properties: { audience: a.audience, studentGroupingType: a.studentGroupingType, timeRequired: a.timeRequired } }),
    ),
  );

  // ── add_assessment ───────────────────────────────────────────────────────────
  server.registerTool(
    "add_assessment",
    {
      title: "Add an Assessment",
      description:
        "Create an LC `Assessment` under `parentId` (a Lesson or LessonGrouping) via `hasPart`. Like an Activity but for graded/checkpoint work: LC props `audience` (1..n), `description` (title), `educationalUse` (defaults to 'Assessment'), `variant`, `timeRequired`. Optional `alignTo` (SFI → hasEducationalAlignment). REQUIRES CONFIRMATION (dry-run → confirmationToken + mintedNodeId). DRAFT edit.",
      inputSchema: {
        parentId: z.string(),
        description: z.string().optional(),
        title_en: z.string().optional(),
        audience: z.array(z.string()).optional(),
        educationalUse: z.string().optional(),
        variant: z.string().optional(),
        timeRequired: z.string().optional(),
        alignTo: z.string().optional(),
        ...CONFIRM,
      },
    },
    guarded(async (a: AddCommon & { parentId: string; audience?: string[]; educationalUse?: string; variant?: string; timeRequired?: string }) =>
      runTypedAdd("Assessment", { ...a, properties: { audience: a.audience, educationalUse: a.educationalUse ?? "Assessment", variant: a.variant, timeRequired: a.timeRequired } }),
    ),
  );

  // ── add_material ─────────────────────────────────────────────────────────────
  server.registerTool(
    "add_material",
    {
      title: "Add a Material",
      description:
        "Create an LC `Material` — the load-bearing content LEAF — under `parentId` (a Course/LessonGrouping/Lesson/Activity/Assessment/InstructionalRoutine) via `hasPart`. LC-required props: `content` (the body text/HTML), `materialType` (e.g. Reference/Worksheet), `audience` (1..n). Optional `description` (name), `educationalUse`, `alignTo` (SFI). Edit `content` later with set_content. REQUIRES CONFIRMATION (dry-run → confirmationToken + mintedNodeId). DRAFT edit.",
      inputSchema: {
        parentId: z.string(),
        description: z.string().optional(),
        title_en: z.string().optional(),
        content: z.string().optional(),
        materialType: z.string().optional(),
        audience: z.array(z.string()).optional(),
        educationalUse: z.string().optional(),
        position: z.number().optional(),
        alignTo: z.string().optional(),
        ...CONFIRM,
      },
    },
    guarded(async (a: AddCommon & { parentId: string; content?: string; materialType?: string; audience?: string[]; educationalUse?: string }) =>
      runTypedAdd("Material", { ...a, properties: { content: a.content, materialType: a.materialType, audience: a.audience, educationalUse: a.educationalUse } }),
    ),
  );

  // ── add_learning_component ───────────────────────────────────────────────────
  server.registerTool(
    "add_learning_component",
    {
      title: "Add a LearningComponent",
      description:
        "Create an LC `LearningComponent` — a single well-defined skill/concept — attached to `parentId` (the StandardsFrameworkItem it decomposes) via `supports` (component → standard). `description` (the skill/concept) is required; optional `examples`. There is no `alignTo` — the `supports` edge IS the alignment. REQUIRES CONFIRMATION (dry-run → confirmationToken + mintedNodeId). DRAFT edit.",
      inputSchema: {
        parentId: z.string(),
        description: z.string().optional(),
        title_en: z.string().optional(),
        examples: z.array(z.string()).optional(),
        ...CONFIRM,
      },
    },
    guarded(async (a: AddCommon & { parentId: string; examples?: string[] }) =>
      runTypedAdd("LearningComponent", { ...a, properties: { examples: a.examples } }),
    ),
  );

  // ── add_standard_framework_item ──────────────────────────────────────────────
  server.registerTool(
    "add_standard_framework_item",
    {
      title: "Add a StandardsFrameworkItem",
      description:
        "Create an LC `StandardsFrameworkItem` (a standard or a grouping of standards) under `parentId` (the StandardsFramework or a parent SFI) via `hasChild` — the STANDARDS axis (distinct from content's hasPart). LC props: `normalizedStatementType` (its functional role — e.g. 'Standard' or 'Standard Grouping'), `description`, `statementType` (framework label), `statementCode` (short code), `gradeLevel`. SFI→SFI prerequisites (buildsTowards/relatesTo) are separate create_edge calls. REQUIRES CONFIRMATION (dry-run → confirmationToken + mintedNodeId). DRAFT edit.",
      inputSchema: {
        parentId: z.string(),
        description: z.string().optional(),
        title_en: z.string().optional(),
        normalizedStatementType: z.string().optional(),
        statementType: z.string().optional(),
        statementCode: z.string().optional(),
        gradeLevel: z.array(z.string()).optional(),
        position: z.number().optional(),
        ...CONFIRM,
      },
    },
    guarded(async (a: AddCommon & { parentId: string; normalizedStatementType?: string; statementType?: string; statementCode?: string; gradeLevel?: string[] }) =>
      runTypedAdd("StandardsFrameworkItem", { ...a, properties: { normalizedStatementType: a.normalizedStatementType, statementType: a.statementType, statementCode: a.statementCode, gradeLevel: a.gradeLevel } }),
    ),
  );

  // ── add_instructional_routine ────────────────────────────────────────────────
  server.registerTool(
    "add_instructional_routine",
    {
      title: "Add an InstructionalRoutine",
      description:
        "Create an LC `InstructionalRoutine` (a recurring teaching structure, or one of its ordered steps) under `parentId` (a parent InstructionalRoutine) via `hasPart`. LC props: `description` (name), `position` (step order), `timeRequired`, `summary` (cross-cutting rules; stored at metadata.summary). To APPLY a routine to a Lesson/Course/Activity, use create_edge with `usesRoutine` — a routine is authored once and applied to many. REQUIRES CONFIRMATION (dry-run → confirmationToken + mintedNodeId). DRAFT edit.",
      inputSchema: {
        parentId: z.string(),
        description: z.string().optional(),
        title_en: z.string().optional(),
        timeRequired: z.string().optional(),
        summary: z.string().optional(),
        position: z.number().optional(),
        ...CONFIRM,
      },
    },
    guarded(async (a: AddCommon & { parentId: string; timeRequired?: string; summary?: string }) =>
      runTypedAdd("InstructionalRoutine", { ...a, properties: { timeRequired: a.timeRequired, "metadata.summary": a.summary } }),
    ),
  );
}
