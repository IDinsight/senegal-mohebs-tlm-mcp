// ── Module: kg-store · recipes · the structural-property edit path ────────────
// renumber / add_* share: editing the STRUCTURAL numbers on a node — a chapter's
// number, a lesson's within-chapter position. This is the analogue of #10's
// UPSERT_PROPERTY_SAFE_PATHS, kept separate so the two editable surfaces never
// blur — wording is #10; structure is here.
//
// NOTE: chapter↔lesson MEMBERSHIP is the `hasChild` edge, not a denormalized
// number. move/split/renumber therefore rewire edges; they cascade no
// chapter-membership number (the old CI maths "Regime-B" join key is gone). A
// chapter's own number is a plain attribute this path edits; lessons follow the
// edge, so renumbering a chapter never touches them.

import type { MutationNode } from "../types.js";
import { readAtPath } from "../upsert-property.js";
import type { StructuralAliases } from "../../types.js";
import { aliasPaths, writeLogical } from "./shared.js";

// The curated set of STRUCTURAL storage paths a recipe may write on an EXISTING
// node. An adapter's `structuralAliases` MUST resolve only to paths in this set —
// if it declares anything else, `structuralEditErrors` rejects the edit, so
// safety never relies on an adapter being careful.
export const STRUCTURAL_EDIT_SAFE_PATHS: ReadonlySet<string> = new Set([
  "order",             // normalized ordering (chapter number / lesson number)
  "raw.metadata.order", // CI maths: the node's own number, mirrored under metadata (LC scheme)
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
