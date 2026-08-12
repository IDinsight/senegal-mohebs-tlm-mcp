/*
 * Public surface of the context module: the active-context state, the scoped
 * path/key helpers, and the shared types/errors. This module is a leaf — context
 * activation (which composes adapters/ + the schema guard) is app-layer glue and
 * lives in src/activate.ts, not here.
 */
export * from "./shared.js";
export * from "./state.js";
export * from "./session.js";
