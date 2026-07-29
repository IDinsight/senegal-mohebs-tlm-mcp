// ── Module: context · shared (leaf) ──────────────────────────────────────────
// Dependency-free context types and errors. No project imports, so any layer can
// use it. ContextNotSetError is thrown from a few places (requireContext, and
// getActiveAdapter in adapters/) and caught by the tool guard, so it lives here
// rather than in state.ts — that keeps those callers from importing the whole
// state module just to reference the error.
export type ActiveContext = { grade: string; subject: string };

export class ContextNotSetError extends Error {
  readonly available: ActiveContext[];
  constructor(available: ActiveContext[]) {
    super("No active teaching context. Choose a grade and subject with set_context first.");
    this.name = "ContextNotSetError";
    this.available = available;
  }
}
