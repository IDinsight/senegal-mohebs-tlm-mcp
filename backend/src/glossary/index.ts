/*
 * Layer: services · module: glossary — barrel.
 *
 * A workspace-scoped bilingual lexicon (translation grounding + terminology),
 * stored as `LexiconEntry` nodes in a reserved KG namespace and edited through
 * the shared two-phase mutation framework.
 */
export { glossaryNamespace, GLOSSARY_GRADE, GLOSSARY_SUBJECT, LEXICON_ENTRY_KIND, LEXICON_ENTRY_LABEL } from "./namespace.js";
export {
  normalizeRenderings, hasAnyRendering, primaryRendering, buildEntryProps, buildLexiconNode,
  isLexiconNode, parseEntry, mergeEntry,
  type Renderings, type LexiconEntryInput, type LexiconEntry,
} from "./model.js";
export { addTerms, editTerm, removeTerms, type AddTermsArgs, type EditTermArgs, type RemoveTermsArgs } from "./mutations.js";
export { readGlossaryEntries, entryApplies } from "./read.js";
