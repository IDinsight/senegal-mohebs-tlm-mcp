import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye } from "lucide-react";
import { isSynth, type GraphModel } from "../lib/graphModel";
import { makeT } from "../i18n";
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

  const t = makeT(lang);
  const synthetic = isSynth(id);
  let kids = model.viewChildren(spec, id, sourceOn);
  if (filter) kids = kids.filter((k) => filter.keep.has(k));
  const hasKids = kids.length > 0;
  const open = filter ? true : expanded.has(id);

  // Always badge the real relation linking this row to its parent — with an arrow
  // showing which way the edge actually flows (down = parent is the source, up =
  // this child is). `folded` marks the semantic hops (a folded edge, or any edge in
  // the by-type view); those keep the emphasised look, while a plain structural
  // hasChild gets a calmer badge so deep containment trees stay legible.
  const link =
    !synthetic && parentId && !isSynth(parentId)
      ? model.relBetween(parentId, id)
      : null;
  const linkRel = link?.rel ?? null;
  const folded = !!linkRel && (spec.shape === "node-type" || linkRel !== "hasChild");

  const node = model.N[id];
  const label = model.nodeLabel(id, lang);
  const isHit = !!filter && filter.hits.has(id);

  // Clicking the row expands/collapses when there's something to unfold; a real
  // leaf (nothing to toggle) opens its detail instead. The dedicated eye button is
  // the explicit "view details" affordance for any real node.
  const onRowClick = () => {
    if (hasKids) onToggle(id);
    else if (!synthetic) onOpen(id);
  };

  return (
    <div className="my-px">
      <div
        className={`group flex cursor-pointer select-none items-center gap-[7px] rounded-md px-[7px] py-[5px] hover:bg-panel2 ${
          selected === id ? "bg-panel2 outline outline-1 outline-accent" : ""
        } ${folded ? "opacity-95" : ""}`}
        onClick={onRowClick}
      >
        <span
          className={`flex w-4 flex-shrink-0 items-center justify-center rounded ${
            hasKids ? "cursor-pointer text-muted hover:bg-line hover:text-txt" : ""
          } ${folded ? "text-task" : ""}`}
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

        {link && (
          <span
            className={`inline-flex flex-shrink-0 items-center gap-0.5 rounded border px-1.5 py-px text-[10px] uppercase tracking-[0.04em] ${
              folded ? "border-line bg-panel2 text-task" : "border-line text-muted"
            }`}
          >
            {link.sourceIsParent ? <ArrowDown size={9} /> : <ArrowUp size={9} />}
            {link.rel}
          </span>
        )}

        {!synthetic && node?.code && (
          <span className="flex-shrink-0 text-[11px] tabular-nums text-muted">
            {node.code}
          </span>
        )}

        <span
          className={`flex-1 truncate ${folded ? "italic" : ""} ${
            isHit ? "text-accent" : ""
          }`}
          title={synthetic ? label : model.desc(node, lang) || ""}
        >
          {label}
        </span>

        {!synthetic && (
          <button
            type="button"
            className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted hover:bg-line hover:text-txt ${
              selected === id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
            title={t("view")}
            aria-label={t("view")}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(id);
            }}
          >
            <Eye size={13} />
          </button>
        )}

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
