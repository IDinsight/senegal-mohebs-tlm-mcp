/*
 * Module: server · tool group: evaluation
 *
 * `evaluate_document` — hand the calling model everything it needs to score a
 * generated document against the evaluation grids attached to it (Senegal's
 * Annexe 8 approval checklist, Annexe 7's scored grid).
 *
 * Same invariant as review_draft, which this mirrors: the SERVER assembles the
 * criteria and the facts, the CALLING model does the judging. Nothing here runs an
 * LLM, and nothing here writes — no scores are stored (that is a later step).
 *
 * A rubric reaches a document through use_rubric, which hangs a Rubric under the
 * document's TeachingLearningMaterial via `hasPart` (see kg-recipes/catalog.ts). So
 * "which grid governs this document" is graph data, and this tool just reads it.
 *
 * The document's TEXT is deliberately NOT inlined: a chapter manual runs to tens of
 * KB and would blow the response cap. We return its bucket path and tell the caller
 * to page it with get_document_text — the same split list_documents uses.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import { currentActor } from "../actor.js";
import { authorize } from "../authz.js";
import { kgNamespace, type MutationGraph, type MutationNode } from "../kg-store/index.js";
import { listEntries } from "../storage/index.js";
import { readActiveGraphWithSlot, resolveDocumentTarget } from "./catalog.js";

const RUBRIC_LABEL = "Rubric";
const RUBRIC_SECTION_LABEL = "RubricSection";
const RUBRIC_CRITERION_LABEL = "RubricCriterion";
const CONTAINMENT = "hasPart";

const rawOf = (node: MutationNode): Record<string, unknown> => (node.properties?.raw as Record<string, unknown>) ?? {};
const metaOf = (node: MutationNode): Record<string, unknown> => (rawOf(node).metadata as Record<string, unknown>) ?? {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const hasLabel = (node: MutationNode, label: string): boolean => (node.labels ?? []).includes(label);

// A criterion's ordinal: raw.position, or raw.metadata.order (CI maths writes both).
// 0 keeps a malformed one in a stable place rather than dropping it.
const orderOf = (node: MutationNode): number => num(rawOf(node).position) ?? num(metaOf(node).order) ?? 0;

export type RubricCriterion = {
  id: string;
  name: string;            // "Alignement aux objectifs"
  indicator: string;       // the measurable indicator the score is judged on
};

export type RubricSection = {
  id: string;
  name: string;
  weight?: string;         // "20%" — Annexe 7 weights its sections; Annexe 8 does not
  criteria: RubricCriterion[];
};

export type AttachedRubric = {
  id: string;
  name: string;
  summary: string;
  scale: string;           // "0-4" | "oui-non"
  sections: RubricSection[];
};

// Read one rubric subtree (Rubric → RubricSection → RubricCriterion) out of the
// active graph. Sections and criteria come back in `position` order so the grid
// reads in the order it was authored.
function describeRubric(graph: MutationGraph, rubric: MutationNode): AttachedRubric {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = (parentId: string): MutationNode[] =>
    graph.edges
      .filter((e) => e.type === CONTAINMENT && e.from === parentId)
      .map((e) => byId.get(e.to))
      .filter((n): n is MutationNode => !!n);

  const sections = childrenOf(rubric.id)
    .filter((n) => hasLabel(n, RUBRIC_SECTION_LABEL))
    .sort((a, b) => orderOf(a) - orderOf(b))
    .map((section) => ({
      id: section.id,
      name: str(rawOf(section).description),
      weight: str(metaOf(section).weight) || undefined,
      criteria: childrenOf(section.id)
        .filter((n) => hasLabel(n, RUBRIC_CRITERION_LABEL))
        .sort((a, b) => orderOf(a) - orderOf(b))
        .map((criterion) => ({
          id: criterion.id,
          name: str(rawOf(criterion).description),
          indicator: str(rawOf(criterion).content),
        })),
    }));

  return {
    id: rubric.id,
    name: str(rawOf(rubric).description),
    summary: str(metaOf(rubric).summary),
    scale: str(metaOf(rubric).scale),
    sections,
  };
}

// What the caller is told to do with the payload. Spelled out because the scoring
// rules differ per scale, and because the single most common failure mode is judging
// a document from its opening pages only.
function instructionFor(rubrics: AttachedRubric[], hasDocument: boolean): string {
  const scales = [...new Set(rubrics.map((r) => r.scale).filter(Boolean))].join(" / ") || "the rubric's own scale";
  const readStep = hasDocument
    ? "FIRST read the whole document: call get_document_text with `document.relPath`, then keep calling it with offset:<nextOffset> until nextOffset is null. A criterion like gender balance or diversity is only answerable from the WHOLE text — never score from the first page alone. "
    : "No generated document is recorded for this node yet, so there is nothing to score. Report that, and point at create_upload_url / log_generation to record one. ";
  return (
    `${readStep}` +
    `Then score EVERY criterion in every rubric above on its scale (${scales}), citing the evidence for each — quote or locate the passage that justifies the score, and give the criterion's id. ` +
    "For a weighted rubric, report each section's score and the weighted total; for an oui/non approval grid, report each answer and list every 'non' as a blocking item. " +
    "Say plainly when a criterion cannot be judged from the text (e.g. it concerns print or paper) rather than guessing a score. " +
    "This tool assembled the inputs; the verdict is yours, and it is recorded nowhere — report it to the user."
  );
}

// Exported so tests drive the real logic without standing up the MCP server.
export async function evaluateDocument(a: { nodeId: string; rubricId?: string }): Promise<Record<string, unknown>> {
  const adapter = getActiveAdapter();
  const namespace = kgNamespace(activeWorkspace(), adapter.grade, adapter.subject);

  const { graph, reading } = await readActiveGraphWithSlot(namespace);
  if (graph.nodes.length === 0) return { error: `No graph in the store for namespace '${namespace}'. Import it first.` };
  if (reading === "draft") {
    const authz = authorize(currentActor(), "readDraft", namespace);
    if (!authz.ok) return { error: `A draft is open and reading it is restricted: ${authz.reason}` };
  }

  // The grids hang off the DOCUMENT, so a Course id resolves to the TLM covering it.
  const resolved = await resolveDocumentTarget(namespace, a.nodeId, "evaluate_document", "rubric");
  if ("error" in resolved) return { error: resolved.error };
  const tlm = graph.nodes.find((n) => n.id === resolved.tlmId)!;

  const attached = graph.edges
    .filter((e) => e.type === CONTAINMENT && e.from === resolved.tlmId)
    .map((e) => graph.nodes.find((n) => n.id === e.to))
    .filter((n): n is MutationNode => !!n && hasLabel(n, RUBRIC_LABEL));

  const selected = a.rubricId ? attached.filter((n) => n.id === a.rubricId) : attached;
  if (selected.length === 0) {
    const reason = a.rubricId
      ? `Rubric '${a.rubricId}' is not attached to document '${resolved.tlmId}'.`
      : `No rubric is attached to document '${resolved.tlmId}'.`;
    return { error: `${reason} Attach one first: list_catalog for the rubric entries, then use_rubric (targetId: '${resolved.tlmId}') and publish_draft.` };
  }
  const rubrics = selected.map((node) => describeRubric(graph, node));

  // The document itself: whatever was last generated for the node this TLM covers.
  const coversNodeId = graph.edges.find((e) => e.type === "covers" && e.from === resolved.tlmId)?.to ?? null;
  const history = await listEntries();
  const document = history.find((entry) => entry.nodeId === coversNodeId || entry.nodeId === resolved.tlmId) ?? null;

  return {
    namespace,
    reading,
    document: {
      tlmId: resolved.tlmId,
      name: str(rawOf(tlm).description),
      coversNodeId,
      relPath: document?.relPath ?? null,
      updated: document?.updated ?? null,
      // What a past generation recorded about the document (characters, domains,
      // concepts) — evidence for criteria the text alone answers slowly.
      recordedContent: document?.content ?? null,
    },
    rubrics,
    criteriaCount: rubrics.reduce((total, r) => total + r.sections.reduce((n, s) => n + s.criteria.length, 0), 0),
    instruction: instructionFor(rubrics, document !== null),
  };
}

export function registerEvaluationTools(server: McpServer) {
  server.registerTool(
    "evaluate_document",
    {
      title: "Evaluate a document against its rubrics",
      description:
        "Score a GENERATED DOCUMENT against the evaluation RUBRICS attached to it (e.g. Annexe 8's approval checklist) — the document-side counterpart of review_draft, which checks the graph. `nodeId` is the document's TeachingLearningMaterial, OR the Course it covers (its TLM is resolved for you); pass `rubricId` to score against just one when several are attached. Returns each rubric's `scale`, its weighted `sections` and their named `criteria` (each with its measurable indicator and node id), the document's bucket `relPath` + last recorded content, and an `instruction`. YOU (the model) then READ the document — page get_document_text to the end, since criteria like gender balance are only answerable from the whole text — and score every criterion with evidence. This tool assembles the inputs; it does not itself render a verdict, run any model, or store the result. A rubric gets attached with use_rubric. Read-only; reading an open draft is curator/approver-gated.",
      inputSchema: {
        nodeId: z.string().describe("The document's TeachingLearningMaterial id, or the Course it covers."),
        rubricId: z.string().optional().describe("Score against only this attached rubric. Omit to use every rubric on the document."),
      },
    },
    guarded(async (a: { nodeId: string; rubricId?: string }) => asJson(await evaluateDocument(a))),
  );
}
