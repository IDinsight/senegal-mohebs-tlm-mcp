import { pick } from "../i18n";
import type { Lang, TaxonomyEntry } from "../types";

type Props = {
  lang: Lang;
  taxonomy: TaxonomyEntry[];
};

// One swatch per LC label present, straight from the server taxonomy — no subject
// vocabulary is hardcoded here.
export function Legend({ lang, taxonomy }: Props) {
  return (
    <div className="flex flex-wrap gap-3 border-b border-line px-3.5 py-2 text-xs text-muted">
      {taxonomy.map((tx) => (
        <span key={tx.key} className="inline-flex items-center gap-1.5">
          <i
            className="h-[9px] w-[9px] flex-shrink-0 rounded-full"
            style={{ background: tx.color }}
          />
          <em className="not-italic">{pick(lang, tx.label)}</em>
        </span>
      ))}
    </div>
  );
}
