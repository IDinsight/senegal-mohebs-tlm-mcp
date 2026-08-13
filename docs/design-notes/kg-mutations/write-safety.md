## Step 0 findings for #6 — write-safety rules

### Stable id (anchor for Rule 1)

- Node id = LC IRI verbatim (`StoredNode.id`).
- Edge id = deterministic `edgeId(type, from, to)` (`StoredEdge.id`).
- Both are the `id` field. That's the field Rule 1 protects.

### Reference regime

Confirmed by reading both adapters + `curriculum/store-bridge.ts`:
`serializeModel` externalizes every parent/child + progression link as a
`hasChild` / `buildsTowards` edge, keyed by node id. `properties.raw` holds
subject-specific content passthrough — including values like `chapitreNum`
or `case_identifier_uuid` that the raw parser uses as match keys, but those
are NOT stored id references. **At the store level, all references are
edges.** The denylist is just the `id` key on nodes and edges.

### Interface widening

The framework's `validate` hook previously received `(base, args)`; Rule 2
needs the AFTER graph, so the signature widened to
`validate(base, after, args)`. The framework now:

1. computes `after = mutation.apply(base, args)`;
2. runs `validateStructural(publishedReference, after)` (Rules 1 + 2)
   unconditionally, where `publishedReference` is ALWAYS the current
   published slot's graph — see the #12 note below for why the reference
   is published rather than base;
3. runs `mutation.validate?(base, after, args)` on top;
4. combines errors — anything present blocks confirmation.

Only one caller existed (the internal `validatingMutation` in the test
file); its signature was updated one-line.

### Decisions

**(a) Rules live in one shared function** —
`kg-store/validate.ts::validateStructural`. Both rules are structural and
don't care about subject. No per-adapter machinery. If a future subject
needs a third rule (or an extra protected key), extend the shared function
or hand it an optional extras list — do NOT ship per-adapter validators.

**(b) Both rules are errors, not warnings.** A silent id mutation orphans
references; a dangling edge is a broken graph. Neither is a judgment call.
Warnings stay reserved for future non-blocking hints (e.g. under-coverage
in #14).

### Load-bearing status

- **Rule 1** — fires today, on any mutation that renames a node/edge.
  Covered by both direct tests and framework-integration tests.
- **Rule 2** — built and tested now, but only becomes load-bearing when
  #12 introduces delete/relink mutations. Today no mutation removes
  nodes or edges, so it's trivially satisfied on live traffic; the
  tests exercise it against crafted before/after graphs and via a
  test-only mutation that deliberately leaves dangling edges.

---
