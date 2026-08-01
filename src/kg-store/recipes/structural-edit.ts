// ── Module: kg-store · recipes · the structural-property edit path ────────────
// The foundation move_lesson / split_chapter / renumber all share: editing the
// STRUCTURAL numbers on an EXISTING node (chapter number, lesson→chapter join
// key, within-chapter position). This is the analogue of #10's
// UPSERT_PROPERTY_SAFE_PATHS, kept separate so the two editable surfaces never
// blur — wording is #10; structure is here.
//
// ── The Regime-B fact that makes this path load-bearing (from #13) ───────────
// The CI maths *presenter* joins a lesson to its chapter by matching
// `raw.chapitreNum`, NOT by the `hasChild` edge. That number is a DENORMALIZED
// copy of the (Rule-2-guarded) edge. #13 resolved its drift as a WARNING, not a
// block. So a recipe that rewires the hasChild edge but leaves `raw.chapitreNum`
// stale would leave the moved lesson rendering under its OLD chapter (and fire
// the drift warning). Therefore move/split/renumber all rewrite `raw.chapitreNum`
// on the affected lessons through THIS path as part of the same atomic composite —
// Rule 2 only blocks genuine EDGE dangling, which a property edit never causes.

import type { MutationNode } from "../types.js";
import { readAtPath } from "../upsert-property.js";
import type { StructuralAliases } from "../../types.js";
import { aliasPaths, writeLogical } from "./shared.js";

// The curated set of STRUCTURAL storage paths a recipe may write on an EXISTING
// node. An adapter's `structuralAliases` MUST resolve only to paths in this set —
// if it declares anything else, `structuralEditErrors` rejects the edit, so
// safety never relies on an adapter being careful.
export const STRUCTURAL_EDIT_SAFE_PATHS: ReadonlySet<string> = new Set([
  "order",           // normalized ordering (chapter number / lesson within-chapter position)
  "raw.chapitreNum", // CI maths: chapter number + the lesson→chapter join key (Regime-B)
  "raw.leconNum",    // CI maths: lesson within-chapter number
]);

// Apply a STRUCTURAL edit to one existing node in `nodes`, returning a new
// nodes array. Pure; assumes the edit has already been validated (see
// `structuralEditErrors`). A no-op when the node or the key's paths are absent.
export function editStructural(nodes: MutationNode[], nodeId: string, key: string, value: number, sAliases: StructuralAliases): MutationNode[] {
  return nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const props = writeLogical(n.properties, n.type, key, value, sAliases);
    return { ...n, properties: props };
  });
}

// The validation half of the structural-property edit path — used by each
// recipe's own `validate`. Confirms: the node exists; the key is declared for
// its kind; every resolved path is on the central safety allowlist; and the
// key currently holds a number on the node (structure edits change existing
// numbers, they don't invent fields — the same "existing key" discipline #10
// applies to wording).
export function structuralEditErrors(node: MutationNode | undefined, nodeId: string, key: string, sAliases: StructuralAliases): string[] {
  const errors: string[] = [];
  if (!node) return [`structural edit: node '${nodeId}' not found in the draft.`];
  const paths = aliasPaths(sAliases, node.type, key);
  if (paths.length === 0) {
    errors.push(`structural edit: key '${key}' is not editable on node kind '${node.type}' (the adapter declares no structuralAliases for it).`);
    return errors;
  }
  for (const p of paths) {
    if (!STRUCTURAL_EDIT_SAFE_PATHS.has(p))
      errors.push(`structural edit: storage path '${p}' (for key '${key}' on kind '${node.type}') is not on the structural safety allowlist. Extend STRUCTURAL_EDIT_SAFE_PATHS to allow it.`);
  }
  if (errors.length > 0) return errors;
  for (const p of paths) {
    const cur = readAtPath(node.properties, p);
    if (typeof cur !== "number")
      errors.push(`structural edit: path '${p}' does not currently hold a number on node '${nodeId}' (current: ${cur === undefined ? "missing" : JSON.stringify(cur)}). Recipes edit existing structural numbers; they do not create the field.`);
  }
  return errors;
}
