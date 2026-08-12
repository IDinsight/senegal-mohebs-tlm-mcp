/*
 * kg-recipes · recipe registry (the get_capabilities mirror)
 *
 * One descriptor per verb. get_capabilities renders THIS array, never a
 * hand-written copy — so the tool list Claude sees can't drift from the verbs
 * actually wired up. Available on every subject; validity is structural (checked
 * against the graph), not a per-subject allowlist.
 */

export type RecipeParam = { name: string; required: boolean; note?: string };
export type RecipeDescriptor = {
  name: string;
  summary: string;
  params: RecipeParam[];
};

export const RECIPES: readonly RecipeDescriptor[] = [
  {
    name: "add_node",
    summary: "Create one node with an LC label and attach it under a parent via the canonical containment edge (hasPart for content, hasChild for standards), at a position. Its identity skeleton is derived from an existing node of that label in the graph (or canonical LC defaults). Optionally align it to a standard.",
    params: [
      { name: "parentId", required: true, note: "the container to attach under" },
      { name: "label", required: true, note: "LC label — Activity / Material / Lesson / LessonGrouping / …" },
      { name: "title", required: false },
      { name: "title_en", required: false },
      { name: "position", required: false, note: "within-parent order; defaults to appending" },
      { name: "via", required: false, note: "containment-edge override; defaults to the canonical edge for the label" },
      { name: "alignTo", required: false, note: "a StandardsFrameworkItem id to align to (hasEducationalAlignment)" },
      { name: "properties", required: false, note: "extra canonical LC props written under raw.* (content, materialType, studentGroupingType, educationalUse, groupName, …)" },
    ],
  },
  {
    name: "move_node",
    summary: "Re-parent a node within the containment tree along one axis (detach the current parent edge, attach the new one, set position). A node's second axis (e.g. a lesson also scheduled under a week) is untouched.",
    params: [
      { name: "nodeId", required: true },
      { name: "toParentId", required: true },
      { name: "via", required: false, note: "containment-edge axis; defaults to the node's canonical edge" },
      { name: "position", required: false, note: "within-target order; defaults to appending" },
    ],
  },
  {
    name: "reposition",
    summary: "Set a node's position (ordinal) among its siblings. Membership is the containment edge, so this never cascades — it is a single-node ordinal edit.",
    params: [
      { name: "nodeId", required: true },
      { name: "position", required: true },
    ],
  },
  {
    name: "set_content",
    summary: "Replace a node's load-bearing content (canonical LC Material.content). The dedicated verb for editing content — upsert_property is wording-only and cannot reach it.",
    params: [
      { name: "nodeId", required: true },
      { name: "content", required: true },
    ],
  },
];
