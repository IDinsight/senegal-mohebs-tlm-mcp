import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { fetchCatalogEntry } from "../lib/api";
import { Markdown } from "../lib/markdown";
import { makeT } from "../i18n";
import type { CatalogEntry, Lang } from "../types";

type Props = {
  lang: Lang;
  ns: string;
  entry: CatalogEntry;
  onClose: () => void;
};

// The click-through detail for a catalog entry: its FULL authored spec (routine
// steps + their material, or a formatter's spec), fetched on open and rendered as
// markdown. Same modal shell as DetailModal so the two feel identical.
export function CatalogEntryModal({ lang, ns, entry, onClose }: Props) {
  const t = makeT(lang);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Load the spec whenever the shown entry changes.
  useEffect(() => {
    let live = true;
    setMarkdown(null);
    setError(false);
    fetchCatalogEntry(ns, entry.id)
      .then((r) => live && setMarkdown(r.markdown))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [ns, entry.id]);

  const tags = [entry.kind, entry.scope].filter(Boolean);

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
        className="flex max-h-[86vh] w-full max-w-[720px] flex-col rounded-2xl border border-line bg-panel shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
      >
        <div className="relative border-b border-line px-5 pb-3.5 pt-[18px]">
          <button
            className="absolute right-3.5 top-3.5 flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-panel2 text-muted hover:border-accent hover:text-txt"
            onClick={onClose}
            aria-label={t("close")}
          >
            <X size={16} />
          </button>
          <h2 className="pr-9 text-base leading-snug">{entry.name || entry.id}</h2>
          <div className="mt-2">
            {tags.map((tag, i) => (
              <span
                key={`${tag}-${i}`}
                className="mb-1 mr-1.5 inline-block rounded border border-line bg-panel2 px-2 py-0.5 text-[10px] uppercase tracking-[0.04em] text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="overflow-auto px-5 pb-5 pt-1.5">
          {error ? (
            <div className="py-6 text-xs text-muted">{t("catalogEntryErr")}</div>
          ) : markdown == null ? (
            <div className="py-6 text-xs text-muted">{t("catalogLoading")}</div>
          ) : (
            <Markdown text={markdown} />
          )}
        </div>
      </div>
    </div>
  );
}
