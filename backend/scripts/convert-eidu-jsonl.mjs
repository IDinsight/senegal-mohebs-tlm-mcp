#!/usr/bin/env node
/*
 * Convert a raw EIDU/CASE knowledge-graph export (two JSONL files — one node
 * per line, one relationship per line) into the canonical Learning-Commons
 * envelope `{ nodes, relationships }` that `import-kg` consumes.
 *
 * The raw export is a flat, snake_case, pipeline-shaped dialect:
 *   - nodes carry `entity_type` (not LC `labels`) and their props at top level;
 *   - relationships carry `relationship_type` + `source_entity_value` /
 *     `target_entity_value` (not `type`/`start`/`end`);
 *   - both carry heavy extraction provenance under `metadata`.
 *
 * The canonical envelope (what the Nigeria fixture already looks like) is:
 *   node: { id, labels: [LClabel], properties: { camelCase…, metadata? } }
 *   rel:  { id, type, start, end, properties: { camelCase… } }
 *
 * This converter mirrors the curation the Nigeria standards-only import applied
 * (confirmed against test/fixtures/nigeria):
 *   - recursively snake_case → camelCase every key (with UUID/URI acronym fixups);
 *   - drop null-valued keys (they carry no information);
 *   - keep node `metadata` only where Nigeria kept it, and only the descriptive
 *     keys — never the audit/merge/claim provenance (see METADATA_ALLOWLIST);
 *   - drop relationship `metadata` entirely.
 *
 * Usage:
 *   node scripts/convert-eidu-jsonl.mjs <nodes.jsonl> <relationships.jsonl> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length !== 3) {
  console.error("convert-eidu-jsonl: expected `<nodes.jsonl> <relationships.jsonl> <out.json>`.");
  process.exit(1);
}
const [nodesPath, relsPath, outPath] = args;

// snake_case → camelCase for one key, restoring the acronym casing the corpus
// uses (`caseIdentifierUUID`, `caseIdentifierURI`) that a naive camel would lose.
function toCamel(key) {
  const camel = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  return camel.replace(/Uuid/g, "UUID").replace(/Uri/g, "URI");
}

// Recursively camelCase every key in a value, walking nested maps and arrays so
// provenance sub-objects (e.g. framework metadata) come out canonical too.
function camelizeDeep(value) {
  if (Array.isArray(value)) return value.map(camelizeDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[toCamel(k)] = camelizeDeep(v);
    return out;
  }
  return value;
}

// Per-label allowlist of the (already camelCased) node metadata keys to keep.
// Anything not listed — audit_flags, merge_decision, candidate_descriptions,
// claims, source_window_ids, … — is pipeline provenance and is dropped, exactly
// as the Nigeria import did. A label absent from this map keeps NO metadata.
const METADATA_ALLOWLIST = {
  StandardsFramework: ["country", "frameworkTitle", "gradesOrStages", "languages", "pageCount", "pdfName", "primaryLanguage"],
  LearningComponent: ["country", "frameworkTitle", "pdfName", "primaryLanguage", "statementTypes", "tags"],
  // StandardsFrameworkItem: intentionally omitted → SFI nodes keep no metadata.
};

function readJsonl(path) {
  return readFileSync(resolve(path), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// Build the camelCased property bag for a node/rel: every non-null key except
// the ones the caller handles specially (entity_type/metadata become labels and
// the curated sidecar; relationship routing keys become type/start/end).
function propertiesExcept(raw, skip) {
  const props = {};
  for (const [k, v] of Object.entries(raw)) {
    if (skip.has(k)) continue;
    if (v === null) continue; // drop nulls — the corpus omits them
    props[toCamel(k)] = camelizeDeep(v);
  }
  return props;
}

function convertNode(raw) {
  const label = raw.entity_type;
  const properties = propertiesExcept(raw, new Set(["entity_type", "metadata"]));

  // Re-attach a curated metadata sidecar only where the corpus keeps one.
  const allow = METADATA_ALLOWLIST[label];
  if (allow && raw.metadata) {
    const meta = camelizeDeep(raw.metadata);
    const kept = {};
    for (const key of allow) if (meta[key] !== undefined && meta[key] !== null) kept[key] = meta[key];
    if (Object.keys(kept).length > 0) properties.metadata = kept;
  }

  return { id: raw.identifier ?? raw.case_identifier_uuid, labels: [label], properties };
}

function convertRel(raw) {
  // Relationships drop their (verbose) metadata entirely — the routing lives in
  // dedicated top-level fields, so metadata is pure provenance here.
  const properties = propertiesExcept(raw, new Set(["metadata"]));
  return {
    id: raw.identifier,
    type: raw.relationship_type,
    start: raw.source_entity_value,
    end: raw.target_entity_value,
    properties,
  };
}

const nodes = readJsonl(nodesPath).map(convertNode);
const relationships = readJsonl(relsPath).map(convertRel);

// Sanity report: label distribution + a dangling-edge check, so a bad export
// surfaces here rather than as a silent mis-parse downstream.
const byLabel = {};
for (const n of nodes) byLabel[n.labels[0]] = (byLabel[n.labels[0]] ?? 0) + 1;
const ids = new Set(nodes.map((n) => n.id));
const dangling = relationships.filter((r) => !ids.has(r.start) || !ids.has(r.end));

console.error(`convert-eidu-jsonl: ${nodes.length} nodes, ${relationships.length} relationships`);
console.error(`  labels: ${JSON.stringify(byLabel)}`);
if (dangling.length > 0) console.error(`  WARNING — ${dangling.length} relationship(s) reference a missing node endpoint.`);

writeFileSync(resolve(outPath), JSON.stringify({ nodes, relationships }, null, 2));
console.error(`convert-eidu-jsonl: wrote ${outPath}`);
