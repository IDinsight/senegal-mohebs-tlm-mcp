import { makeT } from "../i18n";
import type { GraphModel } from "../lib/graphModel";
import { TreeNode } from "./TreeNode";
import type { Lang, ViewSpec } from "../types";

type Filter = { keep: Set<string>; hits: Set<string> } | null;

type Props = {
  lang: Lang;
  model: GraphModel;
  spec: ViewSpec;
  sourceOn: Record<string, boolean>;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selected: string | null;
  onOpen: (id: string) => void;
  filter: Filter;
};

// The scrolling tree: a one-line hint, then the current view's roots. In search
// mode the roots are pruned to those with a surviving descendant.
export function Tree({
  lang,
  model,
  spec,
  sourceOn,
  expanded,
  onToggle,
  selected,
  onOpen,
  filter,
}: Props) {
  const t = makeT(lang);
  let roots = model.viewRoots(spec);
  if (filter) roots = roots.filter((r) => filter.keep.has(r));

  return (
    <>
      <div className="px-3.5 pb-3 pt-0.5 text-xs text-muted">
        {t(spec.shape === "node-type" ? "hintGeneric" : "hintGrouped")}
      </div>
      <div className="overflow-auto px-3.5 pb-20 pt-3.5">
        {roots.map((r) => (
          <TreeNode
            key={r}
            id={r}
            parentId={null}
            model={model}
            spec={spec}
            lang={lang}
            sourceOn={sourceOn}
            expanded={expanded}
            onToggle={onToggle}
            selected={selected}
            onOpen={onOpen}
            filter={filter}
          />
        ))}
      </div>
    </>
  );
}
