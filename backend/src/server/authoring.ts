/*
 * Module: server · node authoring (add_nodes)
 *
 * add_nodes is the SINGLE node-creation tool: create one node or many in ONE
 * atomic draft edit. It replaced the nine per-label typed adds (add_lesson,
 * add_standard_framework_item, …) — those were thin facades over the same
 * addNode recipe, so add_nodes with a one-item batch does everything they did.
 * The per-kind property vocabulary they documented inline now lives in
 * KIND_PROPERTIES (mirrored by get_capabilities) and in this tool's description,
 * so nothing was lost by retiring them.
 *
 * Every add rides the graph-mutation envelope: a dry-run returns a summary (or,
 * with returnMode:"full", the diff) + confirmationToken + minted ids (no state
 * change); the confirm re-checks the token and applies to the DRAFT only. Batch
 * shaping + idempotency live in server/batch.ts. See
 * docs/design-notes/graph-native-authoring.md.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { kgNamespace, mintNodeId, type MutationGraph } from "../kg-store/index.js";
import { addNodes } from "../kg-recipes/index.js";
import { runBatchMutation, type ReturnMode } from "./batch.js";
import { idempotencyPayloadHash } from "./idempotency.js";
import type { SubjectAdapter } from "../types.js";

// The namespace the active subject binds to (same as the other mutation tool groups).
function bind(adapter: SubjectAdapter): { namespace: string } {
  return { namespace: kgNamespace(activeWorkspace(), adapter.grade, adapter.subject) };
}

// One item of an add_nodes batch, as it arrives from the caller. `kind` is the
// LC label (the discriminator); `properties` is the kind-specific canonical LC
// bag (audience, groupName, statementType, content, … — see KIND_PROPERTIES).
type AddNodesItemInput = {
  kind: string;
  parentId?: string;
  description?: string;   // display text → normalized title/text + raw.description
  title_en?: string;
  position?: number;
  via?: string;
  alignTo?: string;
  properties?: Record<string, unknown>;
  mintedNodeId?: string;  // caller's own alias, echoed back in the id map for correlation
};

// The LC labels add_nodes accepts (the discriminator's enum).
const ADD_NODE_KINDS = [
  "Course", "LessonGrouping", "Lesson", "Activity", "Assessment",
  "Material", "LearningComponent", "InstructionalRoutine", "StandardsFrameworkItem",
] as const;

// The kind-specific canonical LC props each label accepts in its `properties`
// bag — the vocabulary the retired typed add tools used to name in their
// schemas. Written under raw.*; exported so get_capabilities mirrors it for
// feature-detection. (Common-to-all fields — description/title_en/position/
// alignTo — are on the item itself, not here.)
export const KIND_PROPERTIES: Record<string, string[]> = {
  Course: ["audience", "educationalUse", "courseCode", "timeRequired"],
  LessonGrouping: ["groupName", "groupLevel", "audience", "educationalUse"],
  Lesson: ["audience", "educationalUse", "timeRequired"],
  Activity: ["audience", "studentGroupingType", "timeRequired"],
  Assessment: ["audience", "educationalUse", "variant", "timeRequired"],
  Material: ["content", "materialType", "audience", "educationalUse"],
  LearningComponent: ["examples"],
  StandardsFrameworkItem: ["normalizedStatementType", "statementType", "statementCode", "gradeLevel"],
  InstructionalRoutine: ["timeRequired", "metadata.summary"],
};

// The same catalog as prose, with the notes the typed tools carried (required
// fields, the bilan flag, the supports-edge case) — embedded in the tool
// description so a caller sees what each kind expects at call time.
const PER_KIND_GUIDE =
  "Per-kind `properties` (canonical LC props → raw.*): " +
  "Course (a ROOT — omit parentId): audience, educationalUse, courseCode, timeRequired · " +
  "LessonGrouping (chapter/unit/week): groupName (REQUIRED — e.g. 'Chapitre'/'Unité'/'Semaine'), groupLevel, audience, educationalUse · " +
  "Lesson: audience, educationalUse (set 'Assessment' to mark a bilan), timeRequired · " +
  "Activity: audience, studentGroupingType, timeRequired · " +
  "Assessment: audience, educationalUse (use 'Assessment'), variant, timeRequired · " +
  "Material: content (body text/HTML), materialType, audience, educationalUse · " +
  "LearningComponent: examples — attaches to its parent StandardsFrameworkItem via `supports` (no alignTo) · " +
  "StandardsFrameworkItem: normalizedStatementType, statementType, statementCode, gradeLevel · " +
  "InstructionalRoutine: timeRequired, 'metadata.summary' (cross-cutting rules). " +
  "Common to every item: `description` (display title), `title_en`, `position`; content kinds may `alignTo` an SFI (hasEducationalAlignment).";

// The add_nodes core, exported so tests drive the real logic (like
// buildCapabilitiesReport). Mints per-item ids, folds them into the batch
// mutation, and delegates response shaping + idempotency to runBatchMutation.
export async function runAddNodes(a: {
  items: AddNodesItemInput[];
  confirm?: boolean;
  confirmationToken?: string;
  mintedNodeIds?: string[];
  returnMode?: ReturnMode;
  idempotencyKey?: string;
}): Promise<Record<string, unknown>> {
  const { namespace } = bind(getActiveAdapter());

  // Mint one real id per item on the dry-run; on confirm reuse the exact ids the
  // caller echoes back, so the args-hash matches the previewed batch.
  const mintedIds = a.confirm ? (a.mintedNodeIds ?? []) : a.items.map(() => mintNodeId());
  const builtItems = a.items.map((item, index) => ({
    label: item.kind,
    parentId: item.parentId,
    newNodeId: mintedIds[index] ?? "",
    title: item.description,
    title_en: item.title_en,
    position: item.position,
    via: item.via,
    alignTo: item.alignTo,
    properties: item.properties,
  }));

  // A { yourAlias → realId } map for items that supplied their own mintedNodeId,
  // surfaced (with mintedNodeIds) on both the preview and the apply summary.
  const mintedNodeIdMap: Record<string, string> = {};
  a.items.forEach((item, index) => {
    if (item.mintedNodeId) {
      mintedNodeIdMap[item.mintedNodeId] = mintedIds[index];
    }
  });

  return runBatchMutation({
    namespace,
    mutation: addNodes,
    args: { namespace, items: builtItems },
    confirm: a.confirm,
    token: a.confirmationToken,
    returnMode: a.returnMode ?? "summary",
    idempotencyKey: a.idempotencyKey,
    payloadHash: idempotencyPayloadHash(builtItems),
    extra: { mintedNodeIds: mintedIds, mintedNodeIdMap },
  });
}

export function registerAuthoringTools(server: McpServer) {
  server.registerTool(
    "add_nodes",
    {
      title: "Add nodes (one or many) in one batch",
      description:
        "The single node-creation tool — create ONE node or MANY in one atomic draft edit (it replaced the per-label add_lesson/add_material/… tools). Each `items[i]` has `kind` (the LC label — Course/LessonGrouping/Lesson/Activity/Assessment/Material/LearningComponent/InstructionalRoutine/StandardsFrameworkItem), an EXISTING `parentId` (omit for a root Course/StandardsFramework), `description` (display title), optional `position`/`alignTo`/`via`, and `properties` (the kind-specific canonical LC bag). " +
        PER_KIND_GUIDE + " " +
        "Each item attaches under an already-existing parent — a node minted in the SAME batch cannot be a parent (stage nodes here, then wire cross-references with create_edges). Optional per-item `mintedNodeId` is your own alias, returned in an id map so you can correlate items to their real ids. ALL-OR-NOTHING: the dry-run validates every item and returns ONE confirmationToken + `mintedNodeIds` (real ids, in item order); any item error blocks the whole batch (no partial apply). To confirm, call again with confirm:true, the token, AND `mintedNodeIds` echoed back verbatim. " +
        "`returnMode` (default 'summary') controls the response: 'summary' returns `counts` {nodesAdded,edgesAdded,nodesChanged,nodesRemoved,edgesRemoved} instead of the full diff (~1 KB — enough to progress to confirm and wire ids); 'full' also attaches the whole `diff`. " +
        "`idempotencyKey` (optional): pass a unique key (a UUID) to make a RETRIED confirm safe — a repeat with the same key + same payload returns the first apply's summary with `replayed:true` (no double-apply, no double-audit) instead of REPLAY; the same key with a different payload is rejected as IDEMPOTENCY_KEY_MISMATCH. Keys are namespace-scoped and expire after 24h. Omit it to keep strict single-use. DRAFT edit — publish_draft to make it live.",
      inputSchema: {
        items: z.array(
          z.object({
            kind: z.enum(ADD_NODE_KINDS),
            parentId: z.string().optional(),
            description: z.string().optional(),
            title_en: z.string().optional(),
            position: z.number().optional(),
            via: z.string().optional(),
            alignTo: z.string().optional(),
            properties: z.record(z.any()).optional(),
            mintedNodeId: z.string().optional(),
          }),
        ),
        returnMode: z.enum(["summary", "full"]).optional(),
        idempotencyKey: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
        mintedNodeIds: z.array(z.string()).optional(),   // real ids, echoed on confirm
      },
    },
    guarded(async (a: {
      items: AddNodesItemInput[]; confirm?: boolean; confirmationToken?: string;
      mintedNodeIds?: string[]; returnMode?: ReturnMode; idempotencyKey?: string;
    }) => asJson(await runAddNodes(a))),
  );
}
