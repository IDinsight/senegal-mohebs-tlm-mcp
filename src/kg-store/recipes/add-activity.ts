// ── Recipe: add_activity (Scope C) ───────────────────────────────────────────
// Create a content `Activity` node — a task/phase (an "Étape") inside a lesson —
// and link it to that EXISTING lesson via `hasPart` (the canonical LC content-
// containment edge), one atomic composite. Additive.
//
// Alignment is DEFAULT OFF: an Activity inherits the coverage of the lesson it
// sits in (the lesson already `hasEducationalAlignment`s the standard it teaches),
// so add_activity writes NO alignment edge. An activity that targets a finer or
// different standard would get an explicit alignment edge via a separate step;
// that is deliberately out of this recipe's surface (keeps coverage simple).
//
// Grain is phase-grained (docs/design-notes/graph-native-authoring.md → Scope C):
// one Activity per phase, its scripted teacher/pupil script stored separately as
// that activity's `Material.content` (add_material).

import type { GraphMutation } from "../mutations.js";
import type { MutationGraph, MutationNode } from "../types.js";
import { createNode, linkNodes } from "../structural.js";
import {
  type RecipeCommon,
  K_LESSON_POSITION, W_TEXT, W_TEXT_EN,
  nodeById, readLogical, asNum, buildProps,
  stampLcProps, lcLabels,
} from "./shared.js";

export type AddActivityArgs = RecipeCommon & {
  lessonId: string;             // the EXISTING lesson (session) this activity sits in
  activityId: string;           // minted by the tool layer
  text: string;                 // the activity's own title (the phase name, e.g. "Étape 1 : …")
  text_en?: string;
  studentGroupingType?: string; // individual / pairs / group (canonical LC Activity prop)
  timeRequired?: string;        // e.g. "10 mn"
  educationalUse?: string;      // Instruction (default) / Assessment
  position?: number;            // within-lesson order; defaults to appending
};

// The Activity children a lesson already holds, via the container (hasPart) EDGE.
function childActivities(g: MutationGraph, lessonId: string, activityKind: string, containerEdge: string): MutationNode[] {
  const out: MutationNode[] = [];
  for (const e of g.edges) {
    if (e.type !== containerEdge || e.from !== lessonId) continue;
    const child = nodeById(g, e.to);
    if (child && child.type === activityKind) out.push(child);
  }
  return out;
}

export const addActivity: GraphMutation<AddActivityArgs> = {
  name: "addActivity",
  describe: (a) => `add an activity to lesson '${a.lessonId}'`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    if (!a.profile.activityKind) errors.push(`add_activity: this subject declares no activityKind in its recipeProfile.`);
    const lesson = nodeById(base, a.lessonId);
    if (!lesson) errors.push(`add_activity: lesson '${a.lessonId}' does not exist in the draft.`);
    else if (lesson.type !== a.profile.lessonKind) errors.push(`add_activity: node '${a.lessonId}' is a '${lesson.type}', not a ${a.profile.lessonKind}.`);
    if (typeof a.text !== "string" || a.text.length === 0) errors.push(`add_activity: 'text' (the activity/phase title) is required.`);
    if (base.nodes.some((n) => n.id === a.activityId)) errors.push(`add_activity: minted activity id '${a.activityId}' already exists (retry).`);
    return { errors, warnings: [] };
  },
  apply: (base, a) => {
    // apply runs BEFORE validate on the dry-run — guard the missing lesson so a
    // bad id yields a clean "blocked" (validate) rather than a throw.
    const activityKind = a.profile.activityKind;
    const lesson = nodeById(base, a.lessonId);
    if (!lesson || !activityKind) return base;
    // Append after the last existing activity's position (read via the activity
    // kind's own structural alias) unless an explicit order was given.
    const siblings = childActivities(base, a.lessonId, activityKind, a.profile.containerEdge);
    const position = a.position ?? (siblings.reduce((m, s) => Math.max(m, asNum(readLogical(s, activityKind, K_LESSON_POSITION, a.structuralAliases)) ?? 0), 0) + 1);
    let properties = buildProps(
      [
        { aliases: a.wordingAliases, kind: activityKind, key: W_TEXT, value: a.text },
        { aliases: a.wordingAliases, kind: activityKind, key: W_TEXT_EN, value: a.text_en },
        { aliases: a.structuralAliases, kind: activityKind, key: K_LESSON_POSITION, value: position },
      ],
      [
        { path: "raw.educationalUse", value: a.educationalUse ?? "Instruction" },
        { path: "raw.studentGroupingType", value: a.studentGroupingType },
        { path: "raw.timeRequired", value: a.timeRequired },
      ],
    );
    // Stamp LC identity (labels/normalizedType) so the created Activity is a
    // faithful LC node that survives a re-parse (labelToKind: Activity → activity).
    properties = stampLcProps(properties, activityKind, a.lcNodeTemplate, null);
    let g = createNode.apply(base, { kind: activityKind, properties, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.activityId, labels: lcLabels(activityKind, a.lcNodeTemplate) });
    // Content containment: the lesson `hasPart` this activity.
    g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.lessonId, toId: a.activityId, properties: { orderInParent: position }, namespace: a.namespace });
    return g;
  },
};
