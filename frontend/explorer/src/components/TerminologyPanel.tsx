import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchTerminology } from "../lib/api";
import { makeT } from "../i18n";
import type { Lang, LexiconEntry } from "../types";

type Props = { lang: Lang; ns: string };

const PAGE_SIZES = [10, 20, 50];

// Diacritics-insensitive match, mirroring the server's noAccents lookup, so
// searching "eleve" finds "élève".
const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const frenchOf = (e: LexiconEntry) => e.renderings.fr ?? "";
const wolofOf = (e: LexiconEntry) => e.renderings.wo ?? "";
// Renderings beyond fr/wo (e.g. en) — shown as small chips under the French cell.
const otherRenderings = (e: LexiconEntry) =>
  Object.entries(e.renderings).filter(([lang]) => lang !== "fr" && lang !== "wo");

// One term as a row: French (+ any narrowing badge and extra-language chips),
// Wolof, and an example sentence.
function EntryRow({ entry }: { entry: LexiconEntry }) {
  const others = otherRenderings(entry);
  const narrowing = [entry.subject, entry.grade].filter(Boolean).join(" · ");
  return (
    <div className="grid grid-cols-1 gap-1 border-t border-line px-3 py-2.5 md:grid-cols-[1fr_1fr_1.2fr] md:gap-3">
      <div className="text-[13px] font-medium text-txt">
        {frenchOf(entry) || <span className="text-muted">—</span>}
        {narrowing && (
          <span className="ml-2 rounded border border-line bg-panel px-1.5 py-0.5 text-[10px] uppercase tracking-[0.03em] text-muted">
            {narrowing}
          </span>
        )}
        {others.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {others.map(([lang, text]) => (
              <span key={lang} className="rounded bg-panel px-1.5 py-0.5 text-[10.5px] text-muted">
                <span className="uppercase text-accent">{lang}</span> {text}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="text-[13px] text-txt">
        {wolofOf(entry) || <span className="text-muted">—</span>}
      </div>
      {entry.example && (
        <div className="text-[12px] italic leading-relaxed text-muted">{entry.example}</div>
      )}
    </div>
  );
}

// The Terminology tab body: the workspace's bilingual lexicon in one width-capped,
// paginated table, filterable by search and split by section headers. Fetches its
// own data by namespace (the server resolves the namespace's workspace glossary).
export function TerminologyPanel({ lang, ns }: Props) {
  const t = makeT(lang);
  const [entries, setEntries] = useState<LexiconEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);

  // (Re)load whenever the namespace changes; ignore a stale response if the ns
  // switched mid-flight.
  useEffect(() => {
    let live = true;
    setEntries(null);
    setError(false);
    setQuery("");
    fetchTerminology(ns)
      .then((r) => live && setEntries(r.entries))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [ns]);

  // Filter across every rendering + the example.
  const filtered = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return entries ?? [];
    return (entries ?? []).filter(
      (e) =>
        Object.values(e.renderings).some((v) => norm(v).includes(q)) ||
        (e.example ? norm(e.example).includes(q) : false),
    );
  }, [entries, query]);

  // Flat list in section order (first-seen), French-sorted within each section,
  // tagging each term with its section so the paginated view can show a header
  // whenever the section changes on the current page.
  const rows = useMemo(() => {
    const order: string[] = [];
    const byTitle = new Map<string, LexiconEntry[]>();
    for (const e of filtered) {
      const key = e.tags?.[0] ?? t("terminologyUntagged");
      if (!byTitle.has(key)) {
        byTitle.set(key, []);
        order.push(key);
      }
      byTitle.get(key)!.push(e);
    }
    return order.flatMap((section) =>
      [...byTitle.get(section)!]
        .sort((a, b) => frenchOf(a).localeCompare(frenchOf(b)))
        .map((entry) => ({ entry, section })),
    );
  }, [filtered, t]);

  // Reset to the first page whenever the result set or page size changes.
  useEffect(() => setPage(0), [query, ns, pageSize]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(current * pageSize, current * pageSize + pageSize);

  return (
    <>
      <div className="px-3.5 pb-3 pt-0.5 text-xs text-muted">{t("terminologyHint")}</div>
      <div className="overflow-auto px-3.5 pb-20 pt-1">
        <div className="mx-auto max-w-4xl">
          {error ? (
            <div className="py-6 text-xs text-muted">{t("terminologyErr")}</div>
          ) : entries == null ? (
            <div className="py-6 text-xs text-muted">{t("terminologyLoading")}</div>
          ) : !entries.length ? (
            <div className="py-6 text-xs text-muted">{t("terminologyEmpty")}</div>
          ) : (
            <>
              <div className="mb-3.5 flex flex-wrap items-center gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("terminologySearch")}
                  className="w-full max-w-xs rounded-lg border border-line bg-panel2 px-3 py-1.5 text-[13px] text-txt placeholder:text-muted focus:border-accent focus:outline-none"
                />
                <span className="text-[11px] text-muted">
                  {rows.length} {t("terminologyCount")}
                </span>
              </div>

              {rows.length === 0 ? (
                <div className="py-6 text-xs text-muted">{t("terminologyNoMatch")}</div>
              ) : (
                <>
                  <div className="overflow-hidden rounded-xl border border-line bg-panel2">
                    <div className="hidden grid-cols-[1fr_1fr_1.2fr] gap-3 border-b border-line bg-panel px-3 py-1.5 text-[10px] uppercase tracking-[0.04em] text-muted md:grid">
                      <span>{t("terminologyFrench")}</span>
                      <span>{t("terminologyWolof")}</span>
                      <span>{t("terminologyExample")}</span>
                    </div>
                    {pageRows.map((r, i) => {
                      const newSection = i === 0 || pageRows[i - 1].section !== r.section;
                      return (
                        <Fragment key={r.entry.id}>
                          {newSection && (
                            <div className="border-t border-line bg-panel px-3 py-1.5 text-[11px] uppercase tracking-[0.05em] text-muted">
                              {r.section}
                            </div>
                          )}
                          <EntryRow entry={r.entry} />
                        </Fragment>
                      );
                    })}
                  </div>

                  {/* Pagination bar: page-size selector + prev/next + page indicator. */}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-muted">{t("terminologyPerPage")}</span>
                      {PAGE_SIZES.map((size) => (
                        <button
                          key={size}
                          onClick={() => setPageSize(size)}
                          className={`rounded border px-2 py-0.5 text-[11px] ${
                            size === pageSize
                              ? "border-accent text-accent"
                              : "border-line text-muted hover:border-accent"
                          }`}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <button
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        disabled={current === 0}
                        className="rounded border border-line px-2 py-0.5 text-muted enabled:hover:border-accent disabled:opacity-40"
                      >
                        ‹ {t("terminologyPrev")}
                      </button>
                      <span className="text-muted">
                        {t("terminologyPage")} {current + 1} / {pageCount}
                      </span>
                      <button
                        onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                        disabled={current >= pageCount - 1}
                        className="rounded border border-line px-2 py-0.5 text-muted enabled:hover:border-accent disabled:opacity-40"
                      >
                        {t("terminologyNext")} ›
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
