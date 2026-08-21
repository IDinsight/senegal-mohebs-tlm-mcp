import { useEffect, useMemo, useState } from "react";
import { fetchTerminology } from "../lib/api";
import { makeT } from "../i18n";
import type { Lang, LexiconEntry } from "../types";

type Props = { lang: Lang; ns: string };

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

// One section (from the entry's first tag): a heading with a count, a column
// header, then the section's terms sorted by French headword.
function SectionBlock({ lang, title, entries }: { lang: Lang; title: string; entries: LexiconEntry[] }) {
  const t = makeT(lang);
  if (!entries.length) return null;
  const sorted = [...entries].sort((a, b) => frenchOf(a).localeCompare(frenchOf(b)));
  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-line bg-panel2">
      <div className="flex items-center justify-between bg-panel px-3 py-2">
        <h3 className="text-[11px] uppercase tracking-[0.05em] text-muted">{title}</h3>
        <span className="text-[11px] text-accent">{entries.length}</span>
      </div>
      <div className="hidden grid-cols-[1fr_1fr_1.2fr] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-[0.04em] text-muted md:grid">
        <span>{t("terminologyFrench")}</span>
        <span>{t("terminologyWolof")}</span>
        <span>{t("terminologyExample")}</span>
      </div>
      {sorted.map((e) => (
        <EntryRow key={e.id} entry={e} />
      ))}
    </div>
  );
}

// The Terminology tab body: the workspace's bilingual lexicon, filterable by a
// search box and grouped by section. Fetches its own data by namespace (the
// server resolves the namespace's workspace glossary), like the Catalog tab.
export function TerminologyPanel({ lang, ns }: Props) {
  const t = makeT(lang);
  const [entries, setEntries] = useState<LexiconEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");

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

  // Group by section (the first tag), preserving first-seen order.
  const groups = useMemo(() => {
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
    return order.map((title) => ({ title, entries: byTitle.get(title)! }));
  }, [filtered, t]);

  return (
    <>
      <div className="px-3.5 pb-3 pt-0.5 text-xs text-muted">{t("terminologyHint")}</div>
      <div className="overflow-auto px-3.5 pb-20 pt-1">
        {error ? (
          <div className="py-6 text-xs text-muted">{t("terminologyErr")}</div>
        ) : entries == null ? (
          <div className="py-6 text-xs text-muted">{t("terminologyLoading")}</div>
        ) : !entries.length ? (
          <div className="py-6 text-xs text-muted">{t("terminologyEmpty")}</div>
        ) : (
          <>
            <div className="mb-3.5 flex items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("terminologySearch")}
                className="w-full max-w-sm rounded-lg border border-line bg-panel2 px-3 py-1.5 text-[13px] text-txt placeholder:text-muted focus:border-accent focus:outline-none"
              />
              <span className="shrink-0 text-[11px] text-muted">
                {filtered.length} {t("terminologyCount")}
              </span>
            </div>
            {groups.length === 0 ? (
              <div className="py-6 text-xs text-muted">{t("terminologyNoMatch")}</div>
            ) : (
              groups.map((g) => (
                <SectionBlock key={g.title} lang={lang} title={g.title} entries={g.entries} />
              ))
            )}
          </>
        )}
      </div>
    </>
  );
}
