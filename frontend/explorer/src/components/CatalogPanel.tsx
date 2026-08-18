import { useEffect, useMemo, useState } from "react";
import { fetchCatalog } from "../lib/api";
import { CatalogEntryModal } from "./CatalogEntryModal";
import { makeT } from "../i18n";
import type { CatalogEntry, CatalogScope, Lang } from "../types";

type Props = { lang: Lang; ns: string };

// One entry rendered as a clickable card: name, a routine|formatter badge, its
// cross-cutting summary, and a step/material footer. Clicking asks the parent to
// open the full-spec modal.
function EntryCard({
  lang,
  entry,
  onOpen,
}: {
  lang: Lang;
  entry: CatalogEntry;
  onOpen: (e: CatalogEntry) => void;
}) {
  const t = makeT(lang);
  return (
    <div
      className="cursor-pointer rounded-xl border border-line bg-panel2 p-3.5 hover:border-accent"
      onClick={() => onOpen(entry)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[14px] font-medium leading-snug text-txt">
          {entry.name || entry.id}
        </div>
        <span className="shrink-0 rounded border border-line bg-panel px-2 py-0.5 text-[10px] uppercase tracking-[0.04em] text-accent">
          {entry.kind === "formatter" ? t("catalogFormatters") : t("catalogRoutines")}
        </span>
      </div>
      {entry.summary && (
        <div className="mt-1.5 line-clamp-3 text-[12.5px] leading-relaxed text-muted">
          {entry.summary}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
        {entry.steps.length > 0 && (
          <span>{entry.steps.length} {t("catalogSteps")}</span>
        )}
        {entry.materialCount > 0 && (
          <span>{entry.materialCount} {t("catalogMaterials")}</span>
        )}
      </div>
    </div>
  );
}

// One scope's section: a heading (workspace / shared library) then its entries,
// routines before formatters, each a card. Empty scopes are omitted entirely.
function ScopeSection({
  lang,
  title,
  entries,
  onOpen,
}: {
  lang: Lang;
  title: string;
  entries: CatalogEntry[];
  onOpen: (e: CatalogEntry) => void;
}) {
  if (!entries.length) return null;
  // Routines first, then formatters; stable name order within each kind.
  const sorted = [...entries].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "routine" ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
  return (
    <div className="mb-6">
      <h3 className="mb-2.5 text-[11px] uppercase tracking-[0.05em] text-muted">
        {title} <span className="text-accent">({entries.length})</span>
      </h3>
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
        {sorted.map((e) => (
          <EntryCard key={`${e.scope}-${e.id}`} lang={lang} entry={e} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

// The Catalog tab body: the two reusable-spec libraries a curator of this
// namespace's workspace can browse — the workspace's own and the shared
// cross-tenant one — each grouped, with click-through to an entry's full spec.
export function CatalogPanel({ lang, ns }: Props) {
  const t = makeT(lang);
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<CatalogEntry | null>(null);

  // (Re)load whenever the namespace changes; ignore a stale response if the ns
  // switched mid-flight.
  useEffect(() => {
    let live = true;
    setEntries(null);
    setError(false);
    setOpen(null);
    fetchCatalog(ns)
      .then((r) => live && setEntries(r.entries))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [ns]);

  const byScope = useMemo(() => {
    const pick = (scope: CatalogScope) => (entries ?? []).filter((e) => e.scope === scope);
    return { workspace: pick("workspace"), shared: pick("shared") };
  }, [entries]);

  return (
    <>
      <div className="px-3.5 pb-3 pt-0.5 text-xs text-muted">{t("catalogHint")}</div>
      <div className="overflow-auto px-3.5 pb-20 pt-3.5">
        {error ? (
          <div className="py-6 text-xs text-muted">{t("catalogErr")}</div>
        ) : entries == null ? (
          <div className="py-6 text-xs text-muted">{t("catalogLoading")}</div>
        ) : !entries.length ? (
          <div className="py-6 text-xs text-muted">{t("catalogEmpty")}</div>
        ) : (
          <>
            <ScopeSection
              lang={lang}
              title={t("catalogScopeWorkspace")}
              entries={byScope.workspace}
              onOpen={setOpen}
            />
            <ScopeSection
              lang={lang}
              title={t("catalogScopeShared")}
              entries={byScope.shared}
              onOpen={setOpen}
            />
          </>
        )}
      </div>

      {open && (
        <CatalogEntryModal
          lang={lang}
          ns={ns}
          entry={open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
