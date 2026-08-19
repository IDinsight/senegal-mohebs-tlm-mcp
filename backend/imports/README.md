# imports/ — converted KGs staged for live import

Canonical Learning-Commons graphs (`{ nodes, relationships }`) ready to load into
the Firestore KG store with `npm run import:kg-store`. Each was produced from a
raw EIDU/CASE JSONL export by `scripts/convert-eidu-jsonl.mjs`.

These are **import inputs, not test fixtures** — they live here (not under
`test/fixtures/`) precisely so `fixtureContexts()` does NOT scan them into the test
matrix. Their subject profiles are still validated at module load, and
`import-kg.mjs --dry-run` exercises their parse.

Layout mirrors the namespace: `imports/<workspace>/<grade>/<subject>/knowledge_graph.json`.

| Workspace | Grade | Subject | Nodes / Edges |
|-----------|-------|---------|---------------|
| cbse   | class-9-10 | science | 1558 / 1797 |
| ghana  | basic-1-3  | english | 662 / 697 |
| ghana  | basic-4-6  | maths   | 548 / 585 |
| madhi  | class-1-5  | maths   | 686 / 713 |
| rwanda | primary-1-3 | maths  | 1391 / 1489 |

Nigeria's corrected maths graph lives under `test/fixtures/nigeria/…` instead — it
is a pre-existing test context whose data was replaced.
