// ── Module: curriculum · internal ────────────────────────────────────────────
// The FR/Wolof glossary lookup for the active subject, loaded lazily from the
// subject's terminology.json and cached until the context changes. Subject-
// agnostic: any subject that ships a terminology.json gets search for free.
import { readFileSync } from "node:fs";
import { CONFIG } from "../config.js";
import { noAccents } from "../utils/index.js";
import { sourcePath, onContextChange } from "../context-state.js";

type TermEntry = { francais: string; wolof: string | null; exemple: string | null; section: string | null };
let termEntries: TermEntry[] = [], termLoaded = false;

function termReload() {
  const raw = JSON.parse(readFileSync(sourcePath(CONFIG.terminologyFile), "utf8"));
  termEntries = [];
  for (const sec of raw.sections ?? [])
    for (const e of sec.entrees ?? [])
      termEntries.push({ francais: e.francais ?? "", wolof: e.wolof ?? null, exemple: e.exemple ?? null, section: sec.titre ?? null });
  termLoaded = true;
}
const termEnsure = () => { if (!termLoaded) termReload(); };
// Switching grade/subject points at a different glossary — drop the cache.
onContextChange(() => { termLoaded = false; termEntries = []; });

export function searchTerminology(query: string, limit = 20) {
  termEnsure();
  const q = noAccents(query);
  return termEntries.filter((e) => noAccents(e.francais).includes(q)).slice(0, limit);
}

export function terminologySections() {
  termEnsure();
  const counts = new Map<string | null, number>();
  for (const e of termEntries) counts.set(e.section, (counts.get(e.section) ?? 0) + 1);
  return [...counts.entries()].map(([titre, count]) => ({ titre, count }));
}
