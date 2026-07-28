#!/usr/bin/env node
// Build-time architecture check (run by `npm run build` before tsc).
//
// Enforces the module layering documented in src/index.ts and README:
//
//   app       server/* · index.ts · activate.ts · http.ts
//   profiles  profiles/*
//   services  storage/* · curriculum/* · generation/* · kg-store/*
//   core      config.ts · types.ts · context/* · utils/*
//
// Rules:
//   1. No import cycles anywhere.
//   2. Imports only ever point DOWN (an importer's layer >= the importee's).
//      In particular, service modules must never import profiles/*.
//   3. Cross-module imports go through the target module's index.ts barrel;
//      only files inside the same module import siblings directly.
//      (Single-file modules — config.ts, types.ts, activate.ts — are their own barrel.)
//
// Exits non-zero with a readable report on any violation.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

// Layer rank per top-level module (higher may import lower or same).
const LAYERS = {
  server: 3, "index.ts": 3, "activate.ts": 3, "http.ts": 3, "consent.ts": 3,
  profiles: 2,
  storage: 1, curriculum: 1, generation: 1, "kg-store": 1,
  config: 0, "config.ts": 0, types: 0, "types.ts": 0, context: 0, utils: 0, "actor.ts": 0, "actor.test.ts": 0,
};

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) files.push(p);
  }
})(SRC);

const rel = (p) => relative(SRC, p).split(sep).join("/");
// The module a file belongs to: its top-level directory, or the root file itself.
const moduleOf = (p) => {
  const parts = rel(p).split("/");
  return parts.length > 1 ? parts[0] : parts[0];
};
const rankOf = (p) => {
  const m = moduleOf(p);
  if (m in LAYERS) return LAYERS[m];
  console.error(`check-cycles: unknown module '${m}' for ${rel(p)} — add it to LAYERS.`);
  process.exit(1);
};

// Resolve a relative import specifier to a source file.
function resolveImport(from, spec) {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
  for (const cand of [base + ".ts", join(base, "index.ts")]) {
    if (existsSync(cand)) return cand;
  }
  return null; // package import or unresolved — ignore
}

const importsOf = new Map();
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']/g;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const targets = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const t = resolveImport(f, m[1]);
    if (t) targets.push({ target: t, spec: m[1] });
  }
  importsOf.set(f, targets);
}

const problems = [];

// Rule 2 + 3: layering and barrel discipline. Test files are exempt from
// layering-up: an integration test physically colocated with a leaf module
// still legitimately exercises app-layer entry points (activateContext, the
// server registry, etc.), and forcing tests to sit at the top of the tree
// scatters them away from what they exercise.
const isTest = (p) => rel(p).endsWith(".test.ts");
for (const [f, targets] of importsOf) {
  for (const { target, spec } of targets) {
    if (rankOf(f) < rankOf(target) && !isTest(f)) {
      problems.push(`layering: ${rel(f)} (layer ${rankOf(f)}) imports UP into ${rel(target)} (layer ${rankOf(target)})`);
    }
    const fromMod = moduleOf(f), toMod = moduleOf(target);
    const toIsRootFile = !rel(target).includes("/");
    if (fromMod !== toMod && !toIsRootFile && !rel(target).endsWith("/index.ts")) {
      problems.push(`barrel: ${rel(f)} imports '${spec}' — cross-module imports must go through ${toMod}/index.ts`);
    }
  }
}

// Rule 1: cycle detection (DFS, file-level).
const WHITE = 0, GREY = 1, BLACK = 2;
const color = new Map(files.map((f) => [f, WHITE]));
const stack = [];
function dfs(f) {
  color.set(f, GREY);
  stack.push(f);
  for (const { target } of importsOf.get(f) ?? []) {
    if (color.get(target) === GREY) {
      const cycle = stack.slice(stack.indexOf(target)).map(rel).join(" -> ");
      problems.push(`cycle: ${cycle} -> ${rel(target)}`);
    } else if (color.get(target) === WHITE) {
      dfs(target);
    }
  }
  stack.pop();
  color.set(f, BLACK);
}
for (const f of files) if (color.get(f) === WHITE) dfs(f);

if (problems.length) {
  console.error(`check-cycles: ${problems.length} violation(s):\n` + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
console.log(`check-cycles: OK (${files.length} files, no cycles, layering respected)`);
