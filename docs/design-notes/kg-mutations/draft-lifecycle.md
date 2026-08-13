## Step 0 findings for #9 + #10 — draft lifecycle + upsert_property

### Term-wording targets (from the LC data + adapters)

There is no "glossary node" in the KG; glossary lives in the local
`terminology.json` (out of scope for graph writes). The pilot's
"wording" targets are the human-readable text fields on curriculum
nodes:

- CI maths chapter: `properties.title` (was `raw.chapitreTitre`)
- CI maths lesson: `properties.text` (was `raw.osTexte`)
- CI maths component + task: `properties.text` (was `raw.description`)
- CE1 reading standard + component: `properties.text` (was `raw.description`)
- English mirrors: `raw.*_en` where present

The adapter's `wordingAliases` declares which LOGICAL keys map to which
storage paths per node kind. A curator says `title` / `text` /
`title_en` / `text_en`; the mutation updates every backing path
atomically.

### Whole-draft diff — decision (a)

Structural recompute from the draft slot vs the published slot. Audit
is a log, not a state oracle. `diffDraft(namespace)` reads both slots,
strips slot tags, and calls the existing `diffGraphs`. Same shape as
#5's per-mutation diff but different scope.

### Draft-level token — decision (b)

`{op: "publish"|"discard", ns, dv: hashGraph(draft), n: nonce}`,
base64url-encoded, distinct payload keys from #5's per-mutation token.
Sibling nonce set (`consumedDraftNonces`) so the two token spaces don't
leak into each other. Confirm rejects with `reason: "the draft moved
since dry-run"` if hashes don't match.

### Missing-key rule — decision (c)

Hard error. Wording pilot means fixing existing text; adding new fields
is #12's job. Both layers of validation run:

1. Adapter's wordingAliases must declare the logical key for the
   node's kind (else "wording key 'X' is not editable on node kind
   'Y'").
2. Every resolved storage path must currently hold a non-null string
   on the node (else "path 'X' does not currently exist as text on
   node 'Y'").

### Namespace source — decision (d)

Active context, via `getActiveAdapter()`. Same convention as every
existing tool in this codebase (no tool takes an explicit namespace).

### Adapter surface — why the "clean layer" mattered

Original proposal was dotted paths that the curator supplies directly.
Refactored based on feedback: a curator says `title`, and the adapter
translates it to `["title", "raw.chapitreTitre"]`. Subject-specific
knowledge lives in subject code; the mutation itself is
subject-agnostic. Safety allowlist (`UPSERT_PROPERTY_SAFE_PATHS`) sits
inside the mutation so an adapter cannot expand the editable surface
by declaring an unlisted path.

---
