import { makeT } from "../i18n";
import type { Lang } from "../types";

type Props = {
  lang: Lang;
  sources: string[];
  sourceOn: Record<string, boolean>;
  onToggle: (key: string, on: boolean) => void;
  onSetAll: (on: boolean) => void;
};

// Provenance filter chips, derived from the srcKeys present in the graph. Hidden
// entirely when the graph carries no source tags.
export function SourceFilters({
  lang,
  sources,
  sourceOn,
  onToggle,
  onSetAll,
}: Props) {
  const t = makeT(lang);
  if (!sources.length) return null;

  return (
    <div className="border-b border-line bg-panel2 px-3.5 py-2.5">
      <div className="mb-2 flex items-baseline gap-2.5">
        <span className="text-[13px] font-semibold text-txt">{t("filtres")}</span>
        <span className="text-[11px] text-muted">{t("sourcesSub")}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {sources.map((key) => {
          const on = sourceOn[key] !== false;
          return (
            <label
              key={key}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-panel px-3 py-[5px] text-[12.5px] ${
                on ? "border-accent text-accent" : "border-line text-txt"
              }`}
            >
              <input
                type="checkbox"
                className="cursor-pointer accent-accent"
                checked={on}
                onChange={(e) => onToggle(key, e.target.checked)}
              />
              {key}
            </label>
          );
        })}
        <span className="ml-2 inline-flex gap-1.5">
          <button
            className="rounded-md border border-line px-2.5 py-1 text-[11px] text-muted hover:border-accent hover:text-txt"
            onClick={() => onSetAll(true)}
          >
            {t("tout")}
          </button>
          <button
            className="rounded-md border border-line px-2.5 py-1 text-[11px] text-muted hover:border-accent hover:text-txt"
            onClick={() => onSetAll(false)}
          >
            {t("aucune")}
          </button>
        </span>
      </div>
    </div>
  );
}
