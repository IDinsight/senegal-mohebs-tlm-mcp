/*
 * Layer: services · module: glossary
 *
 * The shape of a lexicon entry and the pure round-trip between an entry and its
 * stored `LexiconEntry` node. An entry is a set of language-keyed renderings of
 * one concept (a term OR a longer preferred phrase — no length constraint),
 * optionally narrowed to a subject/grade, with an optional example and tags.
 *
 * The multilingual data has no canonical LC slot (LC glossary terms are
 * monolingual), so it lives in the node's `metadata` extension sidecar — the
 * repo's sanctioned channel for "LC has no field for this". A single primary
 * rendering is also mirrored to `properties.text` purely so generic readers
 * (the KG explorer, walk_graph) show a human-readable title.
 */
import type { MutationNode } from "../kg-store/index.js";
import { LEXICON_ENTRY_KIND, LEXICON_ENTRY_LABEL } from "./namespace.js";

// langCode → text, e.g. { fr: "compter", wo: "waññ" }. Codes are lowercased.
export type Renderings = Record<string, string>;

// One entry as an author supplies it (no id yet).
export type LexiconEntryInput = {
  renderings: Renderings;
  subject?: string; // optional narrowing: applies only to this subject when set
  grade?: string;   // optional narrowing: applies only to this grade when set
  example?: string;
  tags?: string[];
  notes?: string;
};

// A stored entry, carrying the node id it round-trips through.
export type LexiconEntry = LexiconEntryInput & { id: string };

// Drop blank values and lowercase the language codes so lookups are stable.
export function normalizeRenderings(renderings: Renderings): Renderings {
  const out: Renderings = {};
  for (const [lang, text] of Object.entries(renderings ?? {})) {
    const value = (text ?? "").trim();
    if (value) out[lang.trim().toLowerCase()] = value;
  }
  return out;
}

export const hasAnyRendering = (renderings: Renderings): boolean =>
  Object.keys(normalizeRenderings(renderings)).length > 0;

// A stable "headword" for display: French if present, else the first rendering.
export function primaryRendering(renderings: Renderings): string {
  const norm = normalizeRenderings(renderings);
  return norm.fr ?? Object.values(norm)[0] ?? "";
}

// Build the `metadata` sidecar for an entry (only the fields that are set).
function entryMetadata(input: LexiconEntryInput): Record<string, unknown> {
  return {
    renderings: normalizeRenderings(input.renderings),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.grade ? { grade: input.grade } : {}),
    ...(input.example ? { example: input.example } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

// The full node `properties` for a lexicon entry: the sidecar plus a display text.
export function buildEntryProps(input: LexiconEntryInput): Record<string, unknown> {
  const metadata = entryMetadata(input);
  return { text: primaryRendering(input.renderings), metadata };
}

// A complete `LexiconEntry` node ready to append to the graph.
export function buildLexiconNode(input: LexiconEntryInput, id: string, namespace: string): MutationNode {
  return {
    id,
    type: LEXICON_ENTRY_KIND,
    namespace,
    spine: true, // a first-class node in its own namespace (not framework filler)
    labels: [LEXICON_ENTRY_LABEL],
    properties: buildEntryProps(input),
  };
}

export const isLexiconNode = (node: MutationNode): boolean =>
  node.type === LEXICON_ENTRY_KIND || (node.labels ?? []).includes(LEXICON_ENTRY_LABEL);

// Read a stored node back into an entry (the inverse of buildLexiconNode).
export function parseEntry(node: MutationNode): LexiconEntry {
  const meta = (node.properties?.metadata ?? {}) as Record<string, unknown>;
  return {
    id: node.id,
    renderings: normalizeRenderings((meta.renderings ?? {}) as Renderings),
    subject: meta.subject as string | undefined,
    grade: meta.grade as string | undefined,
    example: meta.example as string | undefined,
    tags: meta.tags as string[] | undefined,
    notes: meta.notes as string | undefined,
  };
}

// Apply a partial edit to an existing entry: renderings MERGE key-by-key (a
// blank value drops that language); every other supplied field replaces.
export function mergeEntry(current: LexiconEntry, patch: Partial<LexiconEntryInput>): LexiconEntryInput {
  const renderings = patch.renderings
    ? normalizeRenderings({ ...current.renderings, ...patch.renderings })
    : current.renderings;
  return {
    renderings,
    subject: patch.subject ?? current.subject,
    grade: patch.grade ?? current.grade,
    example: patch.example ?? current.example,
    tags: patch.tags ?? current.tags,
    notes: patch.notes ?? current.notes,
  };
}
