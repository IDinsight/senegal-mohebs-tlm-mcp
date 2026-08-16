/*
 * kg-recipes · recipe registry (the get_capabilities mirror)
 *
 * One descriptor per GENERIC verb. get_capabilities renders THIS array, never a
 * hand-written copy — so the tool list Claude sees can't drift from the verbs
 * actually wired up. Node CREATION is add_nodes (server/authoring.ts); edit_node
 * is the generic field-edit verb (content/position/title are the same concept
 * for every label).
 */

export type RecipeParam = { name: string; required: boolean; note?: string };
export type RecipeDescriptor = {
  name: string;
  summary: string;
  params: RecipeParam[];
};

export const RECIPES: readonly RecipeDescriptor[] = [
  {
    name: "edit_node",
    summary: "Edit a node's fields in one atomic draft edit: content (canonical LC Material.content), position (ordinal among siblings — never cascades), title (display name), title_en (English mirror), and/or summary (a routine/formatter's cross-cutting blurb → raw.metadata.summary). Pass at least one. Replaced set_content + reposition and added title editing.",
    params: [
      { name: "nodeId", required: true },
      { name: "content", required: false },
      { name: "position", required: false },
      { name: "title", required: false },
      { name: "title_en", required: false },
      { name: "summary", required: false },
    ],
  },
];
