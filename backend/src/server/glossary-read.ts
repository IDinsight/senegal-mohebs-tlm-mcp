/*
 * Module: server · glossary read resolver (app layer)
 *
 * The single place the read tools (get_terminology, translate) get their
 * effective term list. It resolves the active workspace's published lexicon from
 * the store, narrowed to the active subject/grade; when that namespace doesn't
 * exist yet it falls back to the on-disk terminology.json — so the store can be
 * populated without a flag day and nothing breaks mid-rollout.
 *
 * Both sources are flattened to one `TermResult` shape that keeps the legacy
 * francais/wolof fields (so existing callers are unaffected) while also carrying
 * the full language-keyed `renderings` map for the general case.
 *
 * Lives in the app layer because it composes two services (glossary + the
 * curriculum terminology fallback) with the active context.
 */
import { activeWorkspace, getActiveContext } from "../context/index.js";
import { noAccents } from "../utils/index.js";
import { readGlossaryEntries, entryApplies, glossaryNamespace, type LexiconEntry, type Renderings } from "../glossary/index.js";
import { allTerminologyEntries } from "../curriculum/index.js";

// Legacy-compatible term shape plus the general renderings map.
export type TermResult = {
  francais: string;
  wolof: string | null;
  exemple: string | null;
  section: string | null;
  renderings: Renderings;
};

function fromStoredEntry(entry: LexiconEntry): TermResult {
  return {
    francais: entry.renderings.fr ?? "",
    wolof: entry.renderings.wo ?? null,
    exemple: entry.example ?? null,
    section: entry.tags?.[0] ?? null,
    renderings: entry.renderings,
  };
}

function fromJsonEntry(entry: { francais: string; wolof: string | null; exemple: string | null; section: string | null }): TermResult {
  const renderings: Renderings = {};
  if (entry.francais) renderings.fr = entry.francais;
  if (entry.wolof) renderings.wo = entry.wolof;
  return { francais: entry.francais ?? "", wolof: entry.wolof ?? null, exemple: entry.exemple ?? null, section: entry.section ?? null, renderings };
}

// The term list in effect for the active context: store-backed if the workspace
// has a glossary, otherwise the on-disk fallback.
export async function effectiveTerms(): Promise<TermResult[]> {
  const stored = await readGlossaryEntries(glossaryNamespace(activeWorkspace()));
  if (stored.length > 0) {
    const ctx = getActiveContext();
    return stored
      .filter((entry) => entryApplies(entry, { subject: ctx?.subject, grade: ctx?.grade }))
      .map(fromStoredEntry);
  }
  return allTerminologyEntries().map(fromJsonEntry);
}

const renderingValues = (term: TermResult): string[] => Object.values(term.renderings);

// Look up a single term: keep entries whose any rendering CONTAINS the query
// (the substring behaviour the old searchTerminology had, generalized).
export function filterByQuery(terms: TermResult[], query: string, limit: number): TermResult[] {
  const needle = noAccents(query);
  return terms.filter((term) => renderingValues(term).some((v) => noAccents(v).includes(needle))).slice(0, limit);
}

// Build a term bank for a passage: keep entries whose any rendering APPEARS in
// the passage — the direction the translate grounding needs.
export function filterByText(terms: TermResult[], text: string, limit: number): TermResult[] {
  const haystack = noAccents(text);
  return terms
    .filter((term) => renderingValues(term).some((v) => { const n = noAccents(v); return n.length > 0 && haystack.includes(n); }))
    .slice(0, limit);
}
