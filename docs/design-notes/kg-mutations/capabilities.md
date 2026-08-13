## Step 0 findings for #11 — get_capabilities (read-only mirror)

### The whole point is that it can't lie

Every field in the response is imported from the module that ACTUALLY
enforces or defines it:

- `actor.role` ← `currentActor()` (from #1's verified JWT).
- Every `actions.canX` ← `authorize(actor, action, ns)` — the same
  function every write tool calls. Zero role-mapping logic in the tool.
- `draft.exists` ← `store.readPointer()`; `draft.createdBy` ← the most
  recent `createDraft` audit record.
- `editable.keysByNodeKind` ← `adapter.wordingAliases` (live object).
- `editable.safePaths` ← `UPSERT_PROPERTY_SAFE_PATHS` from mutations.ts.
- `rules.structural` ← `STRUCTURAL_RULES` from validate.ts.

### The mirror-property test

For each of {curator, approver, no-role, unknown} and each gated action,
the test asserts:
```
capabilities.actions[canX] === authorize(actor, X, ns).ok
```
If they ever disagree, the tool is lying or authz has changed — the test
catches drift.

### Decisions (a)–(c) — as implemented

**(a) Live vs static.** Live per-call: `actor`, all `actions.*`,
`draft.exists`, `draft.createdBy`. Sourced from module constants (still
zero drift): `editable.safePaths`, `rules.structural`.

**(b) Unknown-safe.** Unknown callers get a truthful response —
`isKnown: false`, `role: null`, `canReadGenerate: true`, every write
action `false`. Not a 401. Point of the tool.

**(c) `draft.createdBy`.** Included when a draft exists. Cheap
(`listAudit` with `limit: 1`). Helps a second curator see whose draft
they'd be editing.

### New export from validate.ts

Added `STRUCTURAL_RULES: readonly string[]` — human-readable summaries of
Rule 1 and Rule 2. `get_capabilities` imports them so a rule description
change is one file, not two. The validator's own error messages remain
separately worded (they include specifics like the offending id) — this
constant is just the summary Claude tells a curator up-front.

---
