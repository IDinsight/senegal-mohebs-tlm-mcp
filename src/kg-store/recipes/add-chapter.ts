// ── Recipe: add_chapter ───────────────────────────────────────────────────────
// Create a chapter (wording + number at birth) + optional seed lessons (each
// created + linked), as one composite. The number must be FREE — append or
// fill a gap (#14 decision (c)). A colliding number is rejected here; inserting
// BETWEEN existing chapters (which would shift their numbers) is the separate,
// explicit renumber-bearing path, never this additive one.

import type { GraphMutation } from "../mutations.js";
import { createNode, linkNodes } from "../structural.js";
import {
  type RecipeCommon,
  K_CHAPTER_NUMBER, K_LESSON_POSITION, W_TITLE, W_TITLE_EN, W_TEXT, W_TEXT_EN,
  asNum, buildProps, usedChapterNumbers,
  resolveStatementType, stampLcProps, lcLabels,
} from "./shared.js";

export type AddChapterArgs = RecipeCommon & {
  chapterId: string;                                    // minted
  number: number;
  title: string;
  title_en?: string;
  lessons?: Array<{ text: string; text_en?: string; isBilan?: boolean }>;
  lessonIds: string[];                                  // minted, aligned with `lessons`
};

export const addChapter: GraphMutation<AddChapterArgs> = {
  name: "addChapter",
  describe: (a) => `add chapter ${a.number} ('${a.title}')${a.lessons?.length ? ` with ${a.lessons.length} lesson(s)` : ""}`,
  validate: (base, _after, a) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (asNum(a.number) == null) errors.push(`add_chapter: 'number' must be a finite number.`);
    else {
      const used = usedChapterNumbers(base, a.profile, a.structuralAliases);
      if (used.has(a.number)) errors.push(`add_chapter: chapter number ${a.number} is already used by '${used.get(a.number)}'. The additive path needs a FREE number (append or fill a gap); to insert between chapters and shift the rest, use renumber.`);
    }
    if (typeof a.title !== "string" || a.title.length === 0) warnings.push(`add_chapter: chapter created without a title — set one before publishing.`);
    if (base.nodes.some((n) => n.id === a.chapterId)) errors.push(`add_chapter: minted chapter id '${a.chapterId}' already exists (retry).`);
    const lessons = a.lessons ?? [];
    if ((a.lessonIds?.length ?? 0) !== lessons.length) errors.push(`add_chapter: minted lesson id count (${a.lessonIds?.length ?? 0}) does not match seed lesson count (${lessons.length}) — tool-layer wiring bug.`);
    lessons.forEach((l, i) => { if (typeof l.text !== "string" || l.text.length === 0) errors.push(`add_chapter: seed lesson #${i + 1} has no 'text'.`); });
    return { errors, warnings };
  },
  apply: (base, a) => {
    let chapterProps = buildProps(
      [
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE, value: a.title },
        { aliases: a.wordingAliases, kind: a.profile.chapterKind, key: W_TITLE_EN, value: a.title_en },
        { aliases: a.structuralAliases, kind: a.profile.chapterKind, key: K_CHAPTER_NUMBER, value: a.number },
      ],
      [],
    );
    // A chapter's statement_type is a constant ("Chapitre") — no ancestor walk.
    chapterProps = stampLcProps(chapterProps, a.profile.chapterKind, a.lcNodeTemplate, resolveStatementType(base, null, a.profile.chapterKind, a.lcNodeTemplate, a.profile.containerEdge));
    let g = createNode.apply(base, { kind: a.profile.chapterKind, properties: chapterProps, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: a.chapterId, labels: lcLabels(a.profile.chapterKind, a.lcNodeTemplate) });
    (a.lessons ?? []).forEach((l, i) => {
      const lessonId = a.lessonIds[i];
      const position = i + 1;
      let props = buildProps(
        [
          { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT, value: l.text },
          { aliases: a.wordingAliases, kind: a.profile.lessonKind, key: W_TEXT_EN, value: l.text_en },
          { aliases: a.structuralAliases, kind: a.profile.lessonKind, key: K_LESSON_POSITION, value: position },
        ],
        [{ path: a.profile.assessmentProperty, value: l.isBilan ?? false }],
      );
      // Seed lessons sit under a brand-new chapter not yet linked to a domaine,
      // so the strand rarely resolves here — stampLcProps leaves it blank when
      // resolveStatementType returns null, for the reviewer to fill post-publish.
      const strand = resolveStatementType(g, a.chapterId, a.profile.lessonKind, a.lcNodeTemplate, a.profile.containerEdge);
      props = stampLcProps(props, a.profile.lessonKind, a.lcNodeTemplate, strand);
      g = createNode.apply(g, { kind: a.profile.lessonKind, properties: props, namespace: a.namespace, aliases: a.wordingAliases, newNodeId: lessonId, labels: lcLabels(a.profile.lessonKind, a.lcNodeTemplate) });
      g = linkNodes.apply(g, { edgeType: a.profile.containerEdge, fromId: a.chapterId, toId: lessonId, properties: { orderInParent: position }, namespace: a.namespace });
    });
    return g;
  },
};
