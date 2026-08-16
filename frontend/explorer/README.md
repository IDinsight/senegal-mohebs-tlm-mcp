# KG Explorer (frontend)

Read-only React viewer for the Learning Commons knowledge graphs. It reads the
**published** slot of each namespace through the `/kg` endpoints on the
`senegal-mohebs-tlm` Cloud Run service — it never writes, never sees drafts, and
never touches the MCP curator tools. See `docs/technical-reference/explorer.md`
for the full endpoint contract and design rationale.

## Stack

- **Vite** + **React 18** + **TypeScript** (strict)
- **Tailwind CSS v4** (`@tailwindcss/vite`) — the dark palette lives as theme
  tokens in `src/index.css`
- **lucide-react** for icons
- **@supabase/supabase-js** for the optional email/password gate

## Develop

```bash
npm install
npm run dev
```

The dev server proxies `/kg` to `http://localhost:8791` (override with
`KG_API=…`). To skip a local server, point the app at the deployed endpoint:

```
http://localhost:5173/?api=https://senegal-mohebs-tlm-148764688487.europe-west1.run.app
```

## Build

```bash
npm run build      # tsc --noEmit && vite build → dist/
```

Firebase Hosting serves `dist/`; `firebase deploy` runs this build via the
`predeploy` hook in the repo-root `firebase.json`.

## Layout

```
src/
  App.tsx                 orchestration: phase, view/filter/lang UI state
  hooks/useGraphData.ts   async lifecycle (boot → auth → namespaces → graph)
  lib/
    api.ts                fetch + Supabase auth
    graphModel.ts         per-graph indexes + view derivation (the core port)
    search.ts             ancestor-revealing search filter
  components/             Header, Legend, ViewTabs, SourceFilters, Toolbar,
                          Tree/TreeNode, DetailModal, LoginGate, Banner
  i18n.ts                 FR/EN chrome strings; graph content is bilingual data
  types.ts                mirrors src/kg-export.ts (DisplayGraph, ViewSpec, …)
```

`types.ts` mirrors the server's `src/kg-export.ts`. If the `/kg` payload shape
changes, update both.
