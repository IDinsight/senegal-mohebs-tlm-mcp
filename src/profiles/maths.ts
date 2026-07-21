import { noAccents } from "../config.js";
import { createMathsCurriculum, terminologySections } from "../curriculum/index.js";
import { listEntries } from "../storage/index.js";
import { neighborhoodDomains, suggestFreshDomain } from "../generation/index.js";
import type { SubjectProfile, DeliverableSpec, CharacterRef } from "../types.js";

// Teacher guide filenames contain "fiche(s) de leçon"; everything else is the
// pupil manual. The two rules are mutually exclusive, so discovery matches
// exactly one deliverable per file.
const isLessons = (filename: string) => noAccents(filename).includes("fiches de lecons") || noAccents(filename).includes("fiche de lecon");

const DELIVERABLES: DeliverableSpec[] = [
  { key: "manual", label: "Manuel de l'élève (pupil book)", scopeKind: "chapter", classify: (f) => !isLessons(f), dependsOn: [], promptFile: "PROMPT_generate_chapter.md" },
  { key: "lessons", label: "Fiches de leçons (teacher guide)", scopeKind: "chapter", classify: isLessons, dependsOn: ["manual"], promptFile: "PROMPT_generate_lessons.md" },
];

export function buildMathsProfile(grade: string, subject: string): SubjectProfile {
  const curriculum = createMathsCurriculum();

  return {
    grade, subject,
    curriculum,
    deliverables: DELIVERABLES,
    capabilities: { exampleDomainRotation: true, characterConsistency: true },

    // Reproduces the historical getGenerationContext output verbatim.
    async buildGenerationContext(scope, deliverableKey) {
      const chapter = Number(scope);
      const docType = deliverableKey;
      const notes: string[] = [];
      const entries = await listEntries();

      // Aggregate established characters by name; earliest chapter wins, details merge.
      const charMap = new Map<string, { name: string; type?: string; role?: string; description?: string; firstChapter: number }>();
      for (const e of entries) {
        for (const raw of e.content.characters ?? []) {
          const c: CharacterRef = typeof raw === "string" ? { name: raw } : raw;
          if (!c?.name) continue;
          const existing = charMap.get(c.name);
          if (!existing) {
            charMap.set(c.name, { name: c.name, type: c.type, role: c.role, description: c.description, firstChapter: e.chapter });
          } else {
            existing.firstChapter = Math.min(existing.firstChapter, e.chapter);
            existing.type ??= c.type;
            existing.role ??= c.role;
            existing.description ??= c.description;
          }
        }
      }
      const establishedCharacters = [...charMap.values()].sort((a, b) => a.firstChapter - b.firstChapter || a.name.localeCompare(b.name));

      const coverage = (curriculum.listUnits() as Array<{ chapitreNum: number }>).map((c) => ({
        chapter: c.chapitreNum,
        hasManual: entries.some((e) => e.chapter === c.chapitreNum && e.type === "manual"),
        hasLessons: entries.some((e) => e.chapter === c.chapitreNum && e.type === "lessons"),
      }));

      const manualForThisChapter = entries.find((e) => e.id === `${chapter}:manual`) ?? null;
      if (docType === "lessons" && !manualForThisChapter) notes.push(`No pupil manual is tracked for chapter ${chapter}. Lesson sheets build on the manual — generate or ingest the manual first.`);

      const curriculumSlice = curriculum.slice(chapter);
      if (!curriculumSlice) notes.push(`Chapter ${chapter} was not found in the knowledge graph.`);

      return {
        chapter, docType, curriculum: curriculumSlice, progression: curriculum.progression(chapter), requiredLessonCoverage: curriculum.requiredCoverage(chapter),
        establishedCharacters,
        exampleDomains: await (async () => {
          const avoidNearby = await neighborhoodDomains(chapter);
          const suggested = await suggestFreshDomain(avoidNearby);
          return { suggested, avoidNearby };
        })(),
        terminology: { note: "Glossary derives from the KG's own wording; when a term's wording is missing, search the MOHEBS FR/Wolof terminology via get_terminology and use that. Do not invent wording.", sections: terminologySections() },
        coverage, manualForThisChapter, notes,
      };
    },
  };
}
