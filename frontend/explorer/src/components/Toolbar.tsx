import { Search } from "lucide-react";
import { makeT } from "../i18n";
import type { Lang } from "../types";

type Props = {
  lang: Lang;
  query: string;
  onQuery: (q: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
};

// Search box + expand/collapse controls above the tree.
export function Toolbar({
  lang,
  query,
  onQuery,
  onExpandAll,
  onCollapseAll,
}: Props) {
  const t = makeT(lang);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
      <div className="relative flex min-w-[150px] flex-1 items-center">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 text-muted"
        />
        <input
          type="search"
          className="w-full rounded-lg border border-line bg-panel2 py-[7px] pl-9 pr-2.5 text-[13px] text-txt"
          placeholder={t("search")}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <button
        className="rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-xs text-muted hover:border-accent hover:text-txt"
        onClick={onExpandAll}
      >
        {t("expandAll")}
      </button>
      <button
        className="rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-xs text-muted hover:border-accent hover:text-txt"
        onClick={onCollapseAll}
      >
        {t("collapseAll")}
      </button>
    </div>
  );
}
