// ── Module: curriculum · internal ────────────────────────────────────────────
// The FR/Wolof glossary lookup for the active subject, loaded lazily from the
// subject's terminology.json and cached until the context changes. Subject-
// agnostic: any subject that ships a terminology.json gets search for free.
import { readFileSync } from "node:fs";
import { CONFIG } from "../config.js";
import { noAccents } from "../utils/index.js";
import { sourcePath, sessionCache } from "../context/index.js";

type TermEntry = { francais: string; wolof: string | null; exemple: string | null; section: string | null };

// Cached per session (bag key), dropped automatically on context switch.
function termLoad(): TermEntry[] {
  const entries: TermEntry[] = [];
  // A subject may not ship a terminology.json yet (e.g. CE1 reading leans on the
  // KG's own bilingual wording). Treat a missing file as an empty glossary so
  // get_terminology / terminology_sections return [] instead of crashing.
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(sourcePath(CONFIG.terminologyFile), "utf8"));
  } catch {
    return entries;
  }
  for (const sec of raw.sections ?? [])
    for (const e of sec.entrees ?? [])
      entries.push({ francais: e.francais ?? "", wolof: e.wolof ?? null, exemple: e.exemple ?? null, section: sec.titre ?? null });
  return entries;
}
const termEnsure = () => sessionCache("curriculum.terminology", termLoad);

export function searchTerminology(query: string, limit = 20) {
  const entries = termEnsure();
  const q = noAccents(query);
  return entries.filter((e) => noAccents(e.francais).includes(q)).slice(0, limit);
}

export function terminologySections() {
  const counts = new Map<string | null, number>();
  for (const e of termEnsure()) counts.set(e.section, (counts.get(e.section) ?? 0) + 1);
  return [...counts.entries()].map(([titre, count]) => ({ titre, count }));
}
