// ── Layer: app ───────────────────────────────────────────────────────────────
// Orchestrates switching the active teaching context: resolve the subject
// profile, run the schema guard against its knowledge graph, then bind the
// context and install the profile. This is app-layer composition — it wires the
// leaf context module to profiles/ — so it lives at the root alongside index.ts
// rather than inside context/ (which stays a dependency-light leaf).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG } from "./config.js";
import { slug } from "./utils/index.js";
import { setActiveContext, listAvailableContexts, subjectDir, type ActiveContext } from "./context/index.js";
import { resolveProfile, setActiveProfile } from "./profiles/index.js";

export type ActivateResult =
  | { ok: true; context: ActiveContext }
  | { ok: false; error: string; available: ActiveContext[] };

export function activateContext(grade: string, subject: string): ActivateResult {
  const g = slug(grade), s = slug(subject);
  const available = listAvailableContexts();
  const match = available.find((c) => c.grade === g && c.subject === s);
  if (!match) return { ok: false, error: `No sources installed for grade '${grade}' / subject '${subject}'.`, available };

  const profile = resolveProfile(match.grade, match.subject);
  if (!profile) return { ok: false, error: `Sources exist for '${match.grade}/${match.subject}', but no subject profile is registered for it. This grade/subject is not supported yet.`, available };

  // Schema guard: read the KG and confirm the profile's adapter recognizes it,
  // so a mismatched graph fails loudly here instead of mis-parsing downstream.
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(subjectDir(match.grade, match.subject), CONFIG.kgFile), "utf8"));
  } catch (e) {
    return { ok: false, error: `Could not read the knowledge graph for '${match.grade}/${match.subject}': ${(e as Error).message}`, available };
  }
  if (!profile.curriculum.detect(raw)) {
    return { ok: false, error: `The knowledge graph for '${match.grade}/${match.subject}' does not match the schema the '${match.subject}' profile understands. Refusing to load it, since it would mis-parse. See docs/multi-subject-architecture.md.`, available };
  }

  const bound = setActiveContext(match.grade, match.subject); // fires cache-reset listeners
  if (!bound.ok) return bound;
  setActiveProfile(profile);
  return { ok: true, context: bound.context };
}
