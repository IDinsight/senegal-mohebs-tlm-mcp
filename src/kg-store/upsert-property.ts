/*
 * Module: kg-store · internal
 *
 * upsert_property (#10) — the first real edit. A concrete GraphMutation built
 * on the two-phase framework in mutations.ts (same relationship structural.ts
 * and recipes.ts have). Edits ONE logical wording on ONE existing node. The
 * curator supplies a LOGICAL key ("title" / "text" / "title_en" / "text_en");
 * the ADAPTER's wordingAliases (see src/types.ts::WordingAliases) resolves it to
 * the concrete storage paths for that node's kind — typically both the
 * normalized field (what presenters read) and the raw source (what preserves
 * the source graph). All resolved paths are updated atomically in ONE mutation
 * call, ONE audit entry — no drift risk from the curator forgetting a "second
 * update."
 *
 * Safety, layered:
 *   1. Adapter says WHICH logical keys apply on WHICH node kinds and WHERE
 *      each is stored. Subject-specific knowledge, in subject code.
 *   2. This mutation validates every resolved path against the central
 *      SAFE_PATHS allowlist below — a rogue/careless adapter cannot
 *      expand the pilot's editable surface by declaring an unsafe path.
 *   3. Existing-key rule: every resolved path must currently hold a
 *      non-null string on the node. The pilot fixes wording that's there;
 *      it does not create new fields (that's #12's job).
 *   4. #6's structural rules (id-immutable, no-orphan) still run over the
 *      apply result at the framework level.
 */

import type { GraphMutation } from "./mutations.js";
import type { WordingAliases } from "../types.js";

// The central safety allowlist. An adapter's wordingAliases MUST use paths
// from this set — if it declares anything else, upsertProperty rejects the
// call at validate time. Extending the pilot = adding to this set AND
// declaring the new alias on the adapter(s). Two edits, on purpose.
export const UPSERT_PROPERTY_SAFE_PATHS: ReadonlySet<string> = new Set([
  "title", "text",
  "raw.description",              // FR wording source (chapter title, lesson/component/task text)
  "raw.os_texte",                 // CI maths lesson objective mirror
  "raw.metadata.en.description",  // English wording, converged LC scheme
  "raw.metadata.en.os_texte",
]);

// Walk a dotted path over an object, returning the leaf value or undefined.
// Deliberately shallow — no array indexing, no bracket notation — since
// the allowlist paths are all dot-separated object keys.
// Exported so the recipes module (#14) can reuse the exact same path semantics
// for its structural-property edits instead of forking a second copy.
export function readAtPath(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// Return a new object with the leaf at `path` set to `value`, without
// mutating any input. Intermediate objects along the path are cloned;
// siblings are structurally shared.
// Exported for reuse by the recipes module (#14) — same reason as readAtPath.
export function writeAtPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split(".");
  const clone = { ...obj };
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    // The safety allowlist's paths always run through existing objects
    // (properties has 'raw', 'raw' has 'description'/'metadata', etc.). The
    // existing-key rule catches a truly-missing leaf earlier; the empty
    // fallback here is defence-in-depth.
    const nextObj = next && typeof next === "object" && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
    cur[seg] = nextObj;
    cur = nextObj;
  }
  cur[segments[segments.length - 1]] = value;
  return clone;
}

// Args carry the adapter's wordingAliases so the mutation (kg-store, layer 1)
// stays subject-agnostic — the server tool (layer 3) reads them from the
// active adapter and passes them through. See src/server/lifecycle.ts.
export type UpsertPropertyArgs = {
  nodeId: string;
  key: string;                 // logical wording key: "title" | "text" | "title_en" | "text_en" | …
  value: string;
  aliases: WordingAliases;
};

export const upsertProperty: GraphMutation<UpsertPropertyArgs> = {
  name: "upsertProperty",
  describe: ({ nodeId, key }) => `update wording '${key}' on node '${nodeId}'`,
  validate: (base, _after, args) => {
    const errors: string[] = [];
    if (typeof args.value !== "string") {
      errors.push(`value must be a string (got ${typeof args.value})`);
      return { errors, warnings: [] };
    }
    const node = base.nodes.find((n) => n.id === args.nodeId);
    if (!node) {
      errors.push(`node '${args.nodeId}' not found in the draft`);
      return { errors, warnings: [] };
    }
    const aliasesForKind = args.aliases[node.type];
    if (!aliasesForKind) {
      errors.push(
        `node kind '${node.type}' has no editable wording in the active subject. ` +
        `The adapter does not declare any wordingAliases for this kind.`,
      );
      return { errors, warnings: [] };
    }
    const paths = aliasesForKind[args.key];
    if (!paths || paths.length === 0) {
      const available = Object.keys(aliasesForKind);
      errors.push(
        `wording key '${args.key}' is not editable on node kind '${node.type}'. ` +
        `Available keys: ${available.length ? available.join(", ") : "(none)"}.`,
      );
      return { errors, warnings: [] };
    }
    // Central safety allowlist. If an adapter declared a path outside the
    // pilot's approved set, reject — safety cannot rely on adapters being
    // careful.
    for (const path of paths) {
      if (!UPSERT_PROPERTY_SAFE_PATHS.has(path)) {
        errors.push(
          `storage path '${path}' is not on the pilot's safety allowlist ` +
          `(declared by the adapter for wording '${args.key}' on kind '${node.type}'). ` +
          `Extend UPSERT_PROPERTY_SAFE_PATHS in kg-store/upsert-property.ts to allow it.`,
        );
      }
    }
    if (errors.length > 0) return { errors, warnings: [] };
    // Existing-key rule: every resolved path must currently hold a non-null
    // string. Editing wording that's already there is the pilot; creating
    // new fields is not.
    for (const path of paths) {
      const current = readAtPath(node.properties, path);
      if (typeof current !== "string") {
        errors.push(
          `path '${path}' does not currently exist as text on node '${args.nodeId}' ` +
          `(current value: ${current === undefined ? "missing" : JSON.stringify(current)}). ` +
          `This pilot edits existing wording; it does not create new fields.`,
        );
      }
    }
    return { errors, warnings: [] };
  },
  apply: (base, args) => ({
    nodes: base.nodes.map((n) => {
      if (n.id !== args.nodeId) return n;
      const paths = args.aliases[n.type]?.[args.key] ?? [];
      let props = n.properties as Record<string, unknown>;
      for (const path of paths) {
        props = writeAtPath(props, path, args.value);
      }
      return { ...n, properties: props as typeof n.properties };
    }),
    edges: base.edges,
  }),
};
