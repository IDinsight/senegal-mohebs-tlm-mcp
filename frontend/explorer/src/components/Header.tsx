import { Languages, RefreshCw } from "lucide-react";
import { pick } from "../i18n";
import type { Lang, NamespaceEntry } from "../types";

// Pretty workspace name from its id slug: "burkina-faso" → "Burkina Faso".
function wsDisplay(id: string): string {
  return (
    String(id || "")
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || String(id || "")
  );
}

export type StatChip = { value: number; label: string };

type Props = {
  lang: Lang;
  title: string;
  sub: string;
  stats: StatChip[];
  namespaces: NamespaceEntry[];
  currentNs: string | null;
  onSelectNs: (ns: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onToggleLang: () => void;
};

export function Header({
  lang,
  title,
  sub,
  stats,
  namespaces,
  currentNs,
  onSelectNs,
  onRefresh,
  refreshing,
  onToggleLang,
}: Props) {
  // Group graphs by workspace so two workspaces sharing a grade/subject stay
  // distinguishable — one <optgroup> header per workspace, in API order.
  const groups = new Map<string, NamespaceEntry[]>();
  namespaces.forEach((ns) => {
    const ws = ns.workspace || "—";
    if (!groups.has(ws)) groups.set(ws, []);
    groups.get(ws)!.push(ns);
  });

  return (
    <header className="flex flex-wrap items-start gap-2.5 border-b border-line px-[22px] py-[18px]">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="mt-[3px] text-[13px] text-muted">{sub}</div>
        {stats.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {stats.map((chip) => (
              <span
                key={chip.label}
                className="rounded-full border border-line bg-panel2 px-3 py-1 text-xs text-muted"
              >
                <b className="font-semibold text-txt">{chip.value}</b> {chip.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-0.5 flex flex-shrink-0 items-center gap-2">
        {namespaces.length > 0 && (
          <select
            className="max-w-[260px] cursor-pointer rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-[13px] text-txt"
            value={currentNs ?? ""}
            onChange={(e) => onSelectNs(e.target.value)}
            title="Choisir un graphe / Choose a knowledge graph"
          >
            {[...groups.entries()].map(([ws, list]) => (
              <optgroup key={ws} label={wsDisplay(ws)}>
                {list.map((ns) => (
                  <option key={ns.ns} value={ns.ns}>
                    {pick(lang, ns.label)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}

        {namespaces.length > 0 && (
          <button
            className="flex flex-shrink-0 items-center rounded-lg border border-line bg-panel2 px-2.5 py-[5px] text-muted enabled:hover:border-accent enabled:hover:text-txt disabled:opacity-50"
            onClick={onRefresh}
            disabled={refreshing}
            title="Rafraîchir / Refresh"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          </button>
        )}

        <button
          className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel2 px-2.5 py-[5px] text-xs font-semibold text-muted hover:border-accent hover:text-txt"
          onClick={onToggleLang}
          title="Switch language / Changer de langue"
        >
          <Languages size={13} />
          {lang === "fr" ? "EN" : "FR"}
        </button>
      </div>
    </header>
  );
}
