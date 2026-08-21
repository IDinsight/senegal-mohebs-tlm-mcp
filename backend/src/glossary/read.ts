/*
 * Layer: services · module: glossary
 *
 * Read the PUBLISHED lexicon for a workspace's glossary namespace, plus the
 * narrowing rule that decides which entries apply in a given (subject, grade).
 * Reads resolve to published only — a staged draft never reaches a lookup until
 * it is published, matching the curriculum read path.
 */
import { getKgStore } from "../kg-store/index.js";
import { isLexiconNode, parseEntry, type LexiconEntry } from "./model.js";

// All published entries in a glossary namespace. Empty when the namespace has
// never been seeded (no pointer) — the caller falls back to the on-disk glossary.
export async function readGlossaryEntries(namespace: string): Promise<LexiconEntry[]> {
  const store = getKgStore();
  const pointer = await store.readPointer(namespace);
  if (!pointer) return [];
  const nodes = await store.listNodes(namespace, pointer.publishedSlot);
  return nodes.filter(isLexiconNode).map(parseEntry);
}

// Does an entry apply in the active scope? A term with no subject/grade set is
// workspace-wide and always applies; a narrowed term applies only when its
// narrowing matches the active context (so narrower entries surface only in
// their own subject/grade).
export function entryApplies(entry: LexiconEntry, scope: { subject?: string; grade?: string }): boolean {
  if (entry.subject && entry.subject !== scope.subject) return false;
  if (entry.grade && entry.grade !== scope.grade) return false;
  return true;
}
