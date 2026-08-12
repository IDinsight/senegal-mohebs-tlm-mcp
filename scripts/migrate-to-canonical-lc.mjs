// ── Canonical Learning Commons migration (representation at rest) ─────────────
// Rewrites each source knowledge_graph.json from our simplified serialization to
// canonical LC (see docs/design-notes/canonical-lc-migration.md). Deterministic,
// re-runnable, per-subject. What it changes:
//   1. Props snake_case → camelCase on every node + edge (with LC overrides for
//      caseIdentifierURI / caseIdentifierUUID). The `metadata` object is our
//      extension sidecar — kept VERBATIM (provenance + palier/genre live there).
//   2. Content-side containment `hasChild → hasPart` (only where BOTH ends are
//      content nodes: Course/LessonGrouping/Lesson/Activity/Material). The
//      standards hierarchy `hasChild` (Framework/SFI → SFI) stays — LC uses
//      hasChild there.
//   3. Content-source alignment `supports → hasEducationalAlignment` (Lesson /
//      Activity / … → SFI). `LearningComponent → SFI` stays `supports` (canonical).
//   4. Label `Curriculum → Activity | Course` (from normalized_type); drop the
//      now-redundant `normalized_type` on content nodes (the label carries it).
//   5. Ordinal → canonical `position` on content nodes (from metadata.session_order
//      / metadata.order / a bare-number description).
// buildsTowards and relatesTo are left as-is (canonical / out-of-scope cross-links).
//
// Read projections must stay byte-identical after the matching parser lands — the
// golden gates are the acceptance test. Run:
//   node scripts/migrate-to-canonical-lc.mjs [--dry] [grade subject]
// with no grade/subject it processes both installed contexts.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const CONTEXTS = positional.length === 2 ? [positional] : [["ce1", "reading"], ["ci", "maths"]];

// Content-layer labels (final, post-relabel). Everything else — StandardsFramework,
// StandardsFrameworkItem, LearningComponent — is standards side.
const CONTENT_LABELS = new Set(["Course", "LessonGrouping", "Lesson", "Activity", "Material"]);
// snake_case → canonical camelCase, with the two LC acronym overrides.
const KEY_OVERRIDES = { case_identifier_uri: "caseIdentifierURI", case_identifier_uuid: "caseIdentifierUUID" };
const camelKey = (k) => KEY_OVERRIDES[k] ?? k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
// camelCase a property bag's TOP-LEVEL keys, leaving `metadata` (our sidecar) verbatim.
function camelProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props ?? {})) out[k === "metadata" ? "metadata" : camelKey(k)] = v;
  return out;
}
const isContent = (n) => !!n && (n.labels ?? []).some((l) => CONTENT_LABELS.has(l));
// Ordinal source for a content node → canonical `position`.
function positionOf(n) {
  const m = n.properties?.metadata ?? {};
  if (typeof m.session_order === "number") return m.session_order;
  if (typeof m.order === "number") return m.order;
  const d = String(n.properties?.description ?? "");
  return /^\d+$/.test(d) ? Number(d) : null;
}

function migrate(grade, subject) {
  const path = resolve(HERE, "..", "sources", grade, subject, "knowledge_graph.json");
  const graph = JSON.parse(readFileSync(path, "utf8"));
  const stats = { relabeled: 0, hasPartEdges: 0, alignEdges: 0, positionsSet: 0, normalizedTypeDropped: 0, nodes: graph.nodes.length, edges: graph.relationships.length };

  if (graph.relationships.some((r) => r.type === "hasPart") || graph.nodes.some((n) => (n.labels ?? []).includes("Activity"))) {
    return { grade, subject, skipped: "already canonical (hasPart / Activity present)" };
  }

  // 1. Relabel the `Curriculum` catch-all to the real content label its
  //    normalized_type names (Course / LessonGrouping / Activity — the last covers
  //    RECE "Regroupement de tâches" task-groupings), FIRST, so edge endpoint
  //    checks below see final labels.
  const CURRICULUM_LABEL = { "Course": "Course", "Lesson Grouping": "LessonGrouping", "Activity": "Activity" };
  for (const n of graph.nodes) {
    if (!(n.labels ?? []).includes("Curriculum")) continue;
    const label = CURRICULUM_LABEL[n.properties?.normalized_type];
    if (label) { n.labels = [label]; stats.relabeled++; }
    else console.warn(`  WARN unrelabeled Curriculum node ${n.id} (normalized_type=${n.properties?.normalized_type})`);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const before = { node: JSON.parse(JSON.stringify(graph.nodes.find((n) => (n.labels ?? []).includes("Lesson")))) };

  // 2. Nodes: camelCase props, set position on content nodes, drop redundant normalizedType.
  for (const n of graph.nodes) {
    const content = isContent(n);
    const pos = content ? positionOf(n) : null;
    n.properties = camelProps(n.properties);
    if (pos != null) { n.properties.position = pos; stats.positionsSet++; }
    if (content && "normalizedType" in n.properties) { delete n.properties.normalizedType; stats.normalizedTypeDropped++; }
  }

  // 3. Edges: content-containment → hasPart; content-source alignment → hasEducationalAlignment.
  const beforeEdge = JSON.parse(JSON.stringify(graph.relationships.find((r) => {
    const s = byId.get(r.start), t = byId.get(r.end);
    return r.type === "hasChild" && isContent(s) && isContent(t);
  }) ?? null));
  for (const r of graph.relationships) {
    const s = byId.get(r.start), t = byId.get(r.end);
    if (r.type === "hasChild" && isContent(s) && isContent(t)) { r.type = "hasPart"; stats.hasPartEdges++; }
    else if (r.type === "supports" && isContent(s)) { r.type = "hasEducationalAlignment"; stats.alignEdges++; }
    r.properties = camelProps(r.properties);
    if (r.properties.relationshipType) r.properties.relationshipType = r.type;
    // keep the descriptive label arrays honest with the (possibly relabeled) endpoints
    if (r.properties.sourceLabels && s) r.properties.sourceLabels = s.labels ?? [];
    if (r.properties.targetLabels && t) r.properties.targetLabels = t.labels ?? [];
  }

  const after = { node: graph.nodes.find((n) => n.id === before.node.id), edge: graph.relationships.find((r) => r.id === (beforeEdge?.id)) };
  if (!DRY) writeFileSync(path, JSON.stringify(graph, null, 2) + "\n");
  return { grade, subject, stats, sample: { beforeNode: before.node, afterNode: after.node, beforeEdge, afterEdge: after.edge } };
}

for (const [grade, subject] of CONTEXTS) {
  const r = migrate(grade, subject);
  console.log(`\n===== ${grade}/${subject} =====`);
  if (r.skipped) { console.log("SKIPPED:", r.skipped); continue; }
  console.log("counts:", JSON.stringify(r.stats));
  console.log("sample content node BEFORE:", JSON.stringify({ labels: r.sample.beforeNode.labels, props: r.sample.beforeNode.properties }, null, 0).slice(0, 700));
  console.log("sample content node AFTER :", JSON.stringify({ labels: r.sample.afterNode.labels, props: r.sample.afterNode.properties }, null, 0).slice(0, 700));
  if (r.sample.beforeEdge) {
    console.log("sample content edge BEFORE:", JSON.stringify({ type: r.sample.beforeEdge.type, relType: r.sample.beforeEdge.properties?.relationship_type }));
    console.log("sample content edge AFTER :", JSON.stringify({ type: r.sample.afterEdge.type, relType: r.sample.afterEdge.properties?.relationshipType }));
  }
}
console.log(DRY ? "\n(dry run — nothing written)" : "\n(written)");
