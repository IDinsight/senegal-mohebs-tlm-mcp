// ── Module: kg-store · internal ──────────────────────────────────────────────
// Two structural rules the framework applies to every graph mutation before
// the human review gate. They protect against the two errors a reviewer
// cannot eyeball:
//
//   Rule 1 (id-immutable): node/edge ids never silently change. Ids are the
//     LC IRI (nodes) and edgeId(type, from, to) (edges) — every edge points
//     at node ids, so a silent rename orphans everything.
//   Rule 2 (no-orphan): every edge points at nodes that exist. No dangling
//     references after the edit.
//
// Everything else — is the title good, is the wording right, does this
// number make sense — is the reviewer's job when they look at the diff.
// We deliberately don't check content values.
//
// Load-bearing status:
//   - Rule 1 fires today (any mutation that renames a node/edge is blocked).
//   - Rule 2 only starts doing real work when #12 introduces delete/relink
//     mutations. Today no mutation removes edges or nodes, so it's trivially
//     satisfied on live traffic — but it's built and tested now so the check
//     runs automatically the day structural edits arrive.

import type { MutationEdge, MutationGraph, MutationNode, ValidationResult } from "./types.js";

// Human-readable descriptions of the structural rules enforced by
// validateStructural. Read by the get_capabilities tool (#11) so Claude
// can set expectations for a curator BEFORE they try an edit. Editing a
// description here changes it everywhere — the tool imports from this
// module rather than retyping a copy.
export const STRUCTURAL_RULES: readonly string[] = [
  "Rule 1 (id-immutable): node and edge ids never change. Every reference in the graph points at them; a silent rename would orphan everything. A remove/add pair with the same content but a different id is rejected as a rename attempt.",
  "Rule 2 (no-orphan): every edge's from/to must resolve to a node that exists in the graph after the edit. A removed node with surviving incident edges is rejected.",
];

// Two nodes/edges "look like the same thing" when everything except the id
// matches. If that's true across a remove/add pair, the edit was a rename —
// which is exactly what Rule 1 blocks.
function sameContentIgnoringId(a: MutationNode | MutationEdge, b: MutationNode | MutationEdge): boolean {
  const { id: _idA, ...restA } = a;
  const { id: _idB, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

export function validateStructural(base: MutationGraph, after: MutationGraph): ValidationResult {
  const errors: string[] = [];

  // ── Rule 1: no silent rename ─────────────────────────────────────────────
  // Compare what disappeared to what appeared. A same-content pair with a
  // different id is a rename attempt.
  const afterNodeIds = new Set(after.nodes.map((n) => n.id));
  const beforeNodeIds = new Set(base.nodes.map((n) => n.id));
  const removedNodes = base.nodes.filter((n) => !afterNodeIds.has(n.id));
  const addedNodes = after.nodes.filter((n) => !beforeNodeIds.has(n.id));
  for (const gone of removedNodes) {
    const twin = addedNodes.find((added) => sameContentIgnoringId(gone, added));
    if (twin) errors.push(
      `Rule 1 (id-immutable): node id looks renamed ('${gone.id}' → '${twin.id}'). ` +
      `Node ids are the LC IRI and are immutable — every edge points at them. ` +
      `To replace a node, produce a genuinely different node (different content), not the same content under a new id.`,
    );
  }

  const afterEdgeIds = new Set(after.edges.map((e) => e.id));
  const beforeEdgeIds = new Set(base.edges.map((e) => e.id));
  const removedEdges = base.edges.filter((e) => !afterEdgeIds.has(e.id));
  const addedEdges = after.edges.filter((e) => !beforeEdgeIds.has(e.id));
  for (const gone of removedEdges) {
    const twin = addedEdges.find((added) => sameContentIgnoringId(gone, added));
    if (twin) errors.push(
      `Rule 1 (id-immutable): edge id looks renamed ('${gone.id}' → '${twin.id}'). ` +
      `Edge ids are edgeId(type, from, to) and are immutable.`,
    );
  }

  // ── Rule 2: no dangling edges ────────────────────────────────────────────
  // After the edit, every edge's from/to must resolve to a node in the graph.
  // This subsumes "no removed node is still an edge target": a removed node
  // whose incident edges also went away leaves no dangling edge; anything
  // else shows up here.
  for (const edge of after.edges) {
    if (!afterNodeIds.has(edge.from))
      errors.push(`Rule 2 (no-orphan): edge '${edge.id}' has a 'from' that doesn't exist as a node ('${edge.from}').`);
    if (!afterNodeIds.has(edge.to))
      errors.push(`Rule 2 (no-orphan): edge '${edge.id}' has a 'to' that doesn't exist as a node ('${edge.to}').`);
  }

  return { errors, warnings: [] };
}
