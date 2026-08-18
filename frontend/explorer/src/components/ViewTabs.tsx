import { pick } from "../i18n";
import type { Bilingual, Lang } from "../types";

// A tab is just an id + a bilingual label — the graph's viewConfig views satisfy
// this, and so does the synthetic Catalog tab App injects alongside them.
export type TabSpec = { id: string; label: Bilingual };

type Props = {
  lang: Lang;
  views: TabSpec[];
  currentView: string | null;
  onSelect: (id: string) => void;
};

// The view-shape tabs (Standards, Curriculum, Catalogue, By type, …), driven by the
// graph's meta.viewConfig plus the injected Catalog tab — the set differs per graph.
export function ViewTabs({ lang, views, currentView, onSelect }: Props) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
      {views.map((v) => {
        const active = v.id === currentView;
        return (
          <button
            key={v.id}
            onClick={() => onSelect(v.id)}
            className={`rounded-t-lg border border-b-0 px-3.5 py-2 text-[13px] ${
              active
                ? "border-accent bg-panel text-accent"
                : "border-line bg-panel2 text-muted hover:text-txt"
            }`}
          >
            {pick(lang, v.label)}
          </button>
        );
      })}
    </div>
  );
}
