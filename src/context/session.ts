// ── Module: context · session (leaf) ─────────────────────────────────────────
// Session-scoped state container. In HTTP mode every MCP session gets its own
// SessionState (active context + a bag of context-derived caches), carried via
// AsyncLocalStorage so the rest of the codebase reads it implicitly through
// sessionState() — no per-call plumbing. Outside a session (stdio mode, tests)
// a process-wide fallback state is used, which preserves the original
// one-context-per-process behavior exactly.
//
// The bag replaces the old onContextChange listener mechanism: switching
// context clears the session's bag wholesale (state.ts), so every cache keyed
// in it is dropped together. Caches that used module-level `let`s now key into
// the bag instead, which is what makes them session-safe.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ActiveContext } from "./shared.js";

export interface SessionState {
  active: ActiveContext | null;
  /** Context-derived caches (terminology, history, active profile). Cleared on context switch. */
  bag: Map<string, unknown>;
}

export const newSessionState = (): SessionState => ({ active: null, bag: new Map() });

const als = new AsyncLocalStorage<SessionState>();

// stdio mode and unit tests run outside any session — they share this one.
const fallback = newSessionState();

export const sessionState = (): SessionState => als.getStore() ?? fallback;

export const runInSession = <T>(state: SessionState, fn: () => T): T => als.run(state, fn);

/** Get-or-create a cache entry in the current session's bag. */
export function sessionCache<T>(key: string, create: () => T): T {
  const { bag } = sessionState();
  if (!bag.has(key)) bag.set(key, create());
  return bag.get(key) as T;
}
