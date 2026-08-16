import { ChevronDown, ChevronRight } from "lucide-react";
import { isSynth, type GraphModel } from "../lib/graphModel";
import type { Lang, ViewSpec } from "../types";

// One node in the tree — real or synthetic — rendered recursively. Two modes:
// normal (expand/collapse via `expanded`), and search (a `filter` set forces the
// matched branches open and highlights the hits).
type Filter = { keep: Set<string>; hits: Set<string> } | null;

type Props = {
  id: string;
  parentId: string | null;
  model: GraphModel;
  spec: ViewSpec;
  lang: Lang;
  sourceOn: Record<string, boolean>;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selected: string | null;
  onOpen: (id: string) => void;
  filter: Filter;
};

export function TreeNode(props: Props) {
  const {
    id,
    parentId,
    model,
    spec,
    lang,
    sourceOn,
    expanded,
    onToggle,
    selected,
    onOpen,
    filter,
  } = props;

  const synthetic = isSynth(id);
  let kids = model.viewChildren(spec, id, sourceOn);
  if (filter) kids = kids.filter((k) => filter.keep.has(k));
  const hasKids = kids.length > 0;
  const open = filter ? true : expanded.has(id);

  // Badge the real relation. In the node-type view every link is a relation, so
  // badge them all; in a containment tree badge only non-obvious folded edges
  // (leave a genuine hasChild clean).
  const revView = spec.shape === "label-tree" && !!spec.params.reverse;
  const rawRel =
    !synthetic && parentId && !isSynth(parentId)
      ? model.relBetween(parentId, id, revView)
      : null;
  const linkRel =
    rawRel && (spec.shape === "node-type" || rawRel !== "hasChild") ? rawRel : null;

  const node = model.N[id];
  const label = model.nodeLabel(id, lang);
  const isHit = !!filter && filter.hits.has(id);

  const onRowClick = () => {
    if (synthetic) {
      if (hasKids) onToggle(id);
    } else {
      onOpen(id);
    }
  };

  return (
    <div className="my-px">
      <div
        className={`flex cursor-pointer select-none items-center gap-[7px] rounded-md px-[7px] py-[5px] hover:bg-panel2 ${
          selected === id ? "bg-panel2 outline outline-1 outline-accent" : ""
        } ${linkRel ? "opacity-95" : ""}`}
        onClick={onRowClick}
      >
        <span
          className={`flex w-4 flex-shrink-0 items-center justify-center rounded ${
            hasKids ? "cursor-pointer text-muted hover:bg-line hover:text-txt" : ""
          } ${linkRel ? "text-task" : ""}`}
          onClick={(e) => {
            if (hasKids && !filter) {
              e.stopPropagation();
              onToggle(id);
            }
          }}
        >
          {hasKids &&
            (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
        </span>

        <span
          className="h-[9px] w-[9px] flex-shrink-0 rounded-full"
          style={{ background: model.colorFor(id) }}
        />

        {linkRel && (
          <span className="flex-shrink-0 rounded border border-line bg-panel2 px-1.5 py-px text-[10px] uppercase tracking-[0.04em] text-task">
            {linkRel}
          </span>
        )}

        {!synthetic && node?.code && (
          <span className="flex-shrink-0 text-[11px] tabular-nums text-muted">
            {node.code}
          </span>
        )}

        <span
          className={`flex-1 truncate ${linkRel ? "italic" : ""} ${
            isHit ? "text-accent" : ""
          }`}
          title={synthetic ? label : model.desc(node, lang) || ""}
        >
          {label}
        </span>

        {hasKids && (
          <span className="flex-shrink-0 text-[11px] text-muted">{kids.length}</span>
        )}
      </div>

      {hasKids && open && (
        <div className="ml-4 border-l border-line pl-0.5">
          {kids.map((k) => (
            <TreeNode key={k} {...props} id={k} parentId={id} />
          ))}
        </div>
      )}
    </div>
  );
}
