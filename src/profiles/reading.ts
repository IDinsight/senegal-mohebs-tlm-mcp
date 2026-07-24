// ── Layer: profiles (composes the service modules below) ─────────────────────
// The CE1-reading subject profile: a single, standalone deliverable (the weekly
// teacher guide), scoped per WEEK. Reading has no pupil book and no example-domain
// rotation; it does reuse recurring characters and rotates the weekly text theme,
// both derived from generation history. buildGenerationContext() assembles the
// reading-specific pre-generation payload. Services never import back.
import { createReadingCurriculum, terminologySections } from "../curriculum/index.js";
import { listEntries } from "../storage/index.js";
import type { SubjectProfile, DeliverableSpec, CharacterRef } from "../types.js";

// Weeks that are NOT produced with this prompt: integration weeks close each
// palier (9, 17, 24) and week 25 is the end-of-year evaluation. They have their
// own instructions, and the KG carries no language-tool grouping for them.
const NON_GUIDE_WEEKS = new Set([9, 17, 24, 25]);

// Reading ships one deliverable, so any document in the reading namespace is the
// teacher guide. (The generated file is named "Guide enseignant - Semaine N …".)
const DELIVERABLES: DeliverableSpec[] = [
  { key: "teacher_guide", label: "Guide de l'enseignant·e (teacher guide)", scopeKind: "week", classify: () => true, dependsOn: [], promptFile: "PROMPT_generate_lessons.md" },
];

export function buildReadingProfile(grade: string, subject: string): SubjectProfile {
  const curriculum = createReadingCurriculum();

  return {
    grade, subject,
    curriculum,
    deliverables: DELIVERABLES,
    capabilities: { exampleDomainRotation: false, characterConsistency: true },

    async buildGenerationContext(scope, deliverableKey) {
      const week = Number(scope);
      const notes: string[] = [];
      const entries = await listEntries();

      // Aggregate recurring characters by name; earliest week wins, details merge.
      const charMap = new Map<string, { name: string; type?: string; role?: string; description?: string; firstWeek: number }>();
      for (const e of entries) {
        for (const raw of e.content.characters ?? []) {
          const c: CharacterRef = typeof raw === "string" ? { name: raw } : raw;
          if (!c?.name) continue;
          const existing = charMap.get(c.name);
          if (!existing) {
            charMap.set(c.name, { name: c.name, type: c.type, role: c.role, description: c.description, firstWeek: e.chapter });
          } else {
            existing.firstWeek = Math.min(existing.firstWeek, e.chapter);
            existing.type ??= c.type;
            existing.role ??= c.role;
            existing.description ??= c.description;
          }
        }
      }
      const establishedCharacters = [...charMap.values()].sort((a, b) => a.firstWeek - b.firstWeek || a.name.localeCompare(b.name));

      // Themes used by other weeks, most recent first — so this week's texts can
      // pick a fresh one. (No fixed theme pool yet; this reflects real history.)
      const recentThemes = [...entries]
        .filter((e) => e.chapter !== week)
        .sort((a, b) => b.chapter - a.chapter)
        .flatMap((e) => (e.content.exampleDomains ?? []).map((t) => ({ theme: t, week: e.chapter })));

      const coverage = (curriculum.listUnits() as Array<{ semaine: number }>).map((w) => ({
        week: w.semaine,
        hasGuide: entries.some((e) => e.chapter === w.semaine && e.type === "teacher_guide"),
      }));

      const curriculumSlice = curriculum.slice(week);
      if (!curriculumSlice) {
        notes.push(
          NON_GUIDE_WEEKS.has(week)
            ? `Semaine ${week} is an integration or evaluation week — it is produced with its own dedicated instructions, not this teacher-guide prompt. The knowledge graph carries no language-tool targets for it.`
            : `Semaine ${week} was not found in the knowledge graph.`,
        );
      }

      return {
        unit: week, deliverable: deliverableKey,
        curriculum: curriculumSlice, progression: curriculum.progression(week), requiredLanguageToolCoverage: curriculum.requiredCoverage(week),
        establishedCharacters, recentThemes,
        terminology: { note: "Session titles and metalinguistic terms come from the KG's own bilingual wording; when a term's wording is missing, search the MOHEBS FR/Wolof terminology via get_terminology and use that (Wolof for L1 sessions, French for L2). Do not invent wording.", sections: terminologySections() },
        coverage, notes,
      };
    },
  };
}
