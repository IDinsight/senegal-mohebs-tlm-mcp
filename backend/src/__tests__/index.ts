/*
 * Test fixtures — the curriculum graphs the suite parses/seeds.
 *
 * The KG lives only in the store now (docs/design-notes/firestore-only-store.md),
 * so these graphs are plain committed TEST DATA under test/fixtures/, not a
 * runtime source of truth. This module gives tests a `test/fixtures/`-rooted
 * `subjectDir` + `KG_FIXTURE` (drop-in for the old context.subjectDir + CONFIG.kgFile),
 * and — as an import-time side effect — registers the fixture catalog as the
 * installed contexts so `listAvailableContexts()` (and `activateContext`) resolve
 * them without a live store. Importing this module is all a test needs to do.
 */
import { readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setAvailableContexts, type ActiveContext } from "../context/index.js";

// Repo-root/test/fixtures, resolved relative to this file (src/__tests__/).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The fixture graph filename (was CONFIG.kgFile before the KG left the repo).
export const KG_FIXTURE = "knowledge_graph.json";

// The fixture directory for one context (drop-in for the old context.subjectDir).
export const subjectDir = (workspace: string, grade: string, subject: string): string =>
  resolve(ROOT, workspace, grade, subject);

// Every context with a fixture graph, discovered by scanning test/fixtures/
// <workspace>/<grade>/<subject>/, sorted for stable iteration.
export function fixtureContexts(): ActiveContext[] {
  const out: ActiveContext[] = [];
  for (const workspace of readdirSync(ROOT)) {
    const wsPath = resolve(ROOT, workspace);
    if (!isDir(wsPath)) continue;
    for (const grade of readdirSync(wsPath)) {
      const gradePath = resolve(wsPath, grade);
      if (!isDir(gradePath)) continue;
      for (const subject of readdirSync(gradePath)) {
        if (isDir(resolve(gradePath, subject))) out.push({ workspace, grade, subject });
      }
    }
  }
  return out.sort((a, b) =>
    a.workspace.localeCompare(b.workspace) || a.grade.localeCompare(b.grade) || a.subject.localeCompare(b.subject));
}

// Register the fixture catalog as the installed contexts at import time (see the
// header): production populates this from the store at startup; tests populate it
// from the fixtures simply by importing this module.
setAvailableContexts(fixtureContexts());
