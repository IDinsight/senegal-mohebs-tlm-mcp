import { useEffect } from "react";
import { X } from "lucide-react";
import { makeT } from "../i18n";
import type { GraphModel } from "../lib/graphModel";
import type { Lang } from "../types";

// Boilerplate provenance keys that show up as header tags or are just noise — kept
// out of the generic Properties grid.
const SKIP = new Set([
  "identifier",
  "license",
  "attribution_statement",
  "provider",
  "source_key",
  "normalized_type",
  "normalized_statement_type",
  "statement_type",
  "description",
  "statement_code",
]);

type Props = {
  lang: Lang;
  model: GraphModel;
  id: string;
  onClose: () => void;
  onOpen: (id: string) => void;
};

// A clickable list of related nodes (parent / children / buildsTowards chains).
function RelBlock({
  title,
  ids,
  dir,
  lang,
  model,
  onOpen,
}: {
  title: string;
  ids: string[];
  dir: string;
  lang: Lang;
  model: GraphModel;
  onOpen: (id: string) => void;
}) {
  const present = ids.filter((id) => model.N[id]);
  if (!present.length) return null;
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-[11px] uppercase tracking-[0.05em] text-muted">
        {title} <span className="text-accent">({present.length})</span>
      </h3>
      {present.map((tid) => {
        const x = model.N[tid];
        return (
          <div
            key={tid}
            className="my-1.5 cursor-pointer rounded-lg border border-line bg-panel2 px-[11px] py-[9px] text-[13px] hover:border-accent"
            onClick={() => onOpen(tid)}
          >
            <span className="text-[11px] font-semibold text-accent">{dir}</span>
            {x.code && (
              <span className="ml-1.5 text-[11px] tabular-nums text-muted">
                {x.code}
              </span>
            )}
            <div className="mt-[3px] leading-normal text-txt">
              {model.desc(x, lang) || ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DetailModal({ lang, model, id, onClose, onOpen }: Props) {
  const t = makeT(lang);

  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const n = model.N[id];
  if (!n) return null;

  const stShow = lang === "en" ? n.st_en || n.st : n.st;
  const tags = [n.label, n.nt, stShow, n.code, n.srcKey].filter(Boolean);

  // Generic Learning-Commons properties — the raw property bag rendered
  // key/value, minus boilerplate provenance.
  const props = n.props || {};
  const rows = Object.keys(props)
    .filter((k) => !SKIP.has(k))
    .map((k) => [k, props[k]] as const)
    .filter(
      ([, v]) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0),
    );

  const parentId = model.inHasChild[id];
  const children = model.outTargets(id, "hasChild");
  const buildsTo = model.btOut[id] || [];
  const builtFrom = model.btIn[id] || [];
  const noRelations =
    !rows.length && !parentId && !children.length && !buildsTo.length && !builtFrom.length;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(6,8,12,0.66)] p-5 backdrop-blur-[3px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[86vh] w-full max-w-[640px] flex-col rounded-2xl border border-line bg-panel shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
      >
        <div className="relative border-b border-line px-5 pb-3.5 pt-[18px]">
          <button
            className="absolute right-3.5 top-3.5 flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-panel2 text-muted hover:border-accent hover:text-txt"
            onClick={onClose}
            aria-label={t("close")}
          >
            <X size={16} />
          </button>
          <h2 className="pr-9 text-base leading-snug">
            {model.desc(n, lang) || n.code || n.label}
          </h2>
          <div className="mt-2">
            {tags.map((tag, i) => (
              <span
                key={`${tag}-${i}`}
                className="mb-1 mr-1.5 inline-block rounded border border-line bg-panel2 px-2 py-0.5 text-[10px] text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="overflow-auto px-5 pb-5 pt-1.5">
          {rows.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-[11px] uppercase tracking-[0.05em] text-muted">
                {t("properties")}
              </h3>
              <div className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1 text-[13px]">
                {rows.map(([k, v]) => {
                  const disp = Array.isArray(v)
                    ? v.join(", ")
                    : typeof v === "object"
                      ? JSON.stringify(v)
                      : String(v);
                  return (
                    <div key={k} className="contents">
                      <div className="text-muted">{k}</div>
                      <div className="text-txt">{disp}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {parentId && (
            <RelBlock
              title={t("parent")}
              ids={[parentId]}
              dir="parent"
              lang={lang}
              model={model}
              onOpen={onOpen}
            />
          )}
          <RelBlock
            title={t("children")}
            ids={children}
            dir="hasChild"
            lang={lang}
            model={model}
            onOpen={onOpen}
          />
          <RelBlock
            title={t("prepTo")}
            ids={buildsTo}
            dir="buildsTowards"
            lang={lang}
            model={model}
            onOpen={onOpen}
          />
          <RelBlock
            title={t("builtFrom")}
            ids={builtFrom}
            dir="from"
            lang={lang}
            model={model}
            onOpen={onOpen}
          />

          {noRelations && (
            <div className="py-6 text-xs text-muted">{t("noRel")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
