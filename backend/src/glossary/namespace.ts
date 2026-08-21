/*
 * Layer: services · module: glossary
 *
 * Where the bilingual lexicon lives and what its nodes are called. The glossary
 * is a workspace-scoped store, so — exactly like the catalog — it rides a
 * reserved KG namespace (a pseudo grade/subject pair) rather than sitting inside
 * any one subject's curriculum graph. That gives it the whole kg-store machinery
 * (double-buffer, two-phase mutations, publish, audit, roles) for free while
 * keeping it shared across every grade and subject in the workspace.
 */
import { kgNamespace } from "../kg-store/index.js";

// The reserved (grade, subject) pair the glossary namespace uses. Mirrors the
// catalog's `_catalog/routines` convention so it can't collide with a real
// subject namespace.
export const GLOSSARY_GRADE = "_glossary";
export const GLOSSARY_SUBJECT = "terms";

// The namespace holding one workspace's whole lexicon: `<workspace>/_glossary/terms`.
export const glossaryNamespace = (workspace: string): string =>
  kgNamespace(workspace, GLOSSARY_GRADE, GLOSSARY_SUBJECT);

// Our own non-canonical node type/label for a lexicon entry. Deliberately NOT
// LC's `GlossaryTerm` (a monolingual, lesson-referenced canonical node with no
// translation edge) — a LexiconEntry is a standalone, multilingual authoring
// lookup, so it carries a distinct label to avoid any confusion or collision.
export const LEXICON_ENTRY_KIND = "LexiconEntry";
export const LEXICON_ENTRY_LABEL = "LexiconEntry";
