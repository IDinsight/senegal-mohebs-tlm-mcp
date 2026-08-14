/*
 * kg-recipes · recipe registry (the get_capabilities mirror)
 *
 * One descriptor per GENERIC verb. get_capabilities renders THIS array, never a
 * hand-written copy — so the tool list Claude sees can't drift from the verbs
 * actually wired up. Node CREATION is the typed authoring tools
 * (server/authoring.ts, add_course/add_lesson/…); these two verbs remain generic
 * because ordinal and content are the same concept for every label.
 */

export type RecipeParam = { name: string; required: boolean; note?: string };
export type RecipeDescriptor = {
  name: string;
  summary: string;
  params: RecipeParam[];
};

export const RECIPES: readonly RecipeDescriptor[] = [
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
    summary: "Replace a node's load-bearing content (canonical LC Material.content). The dedicated verb for editing a node's content.",
    params: [
      { name: "nodeId", required: true },
      { name: "content", required: true },
    ],
  },
];
