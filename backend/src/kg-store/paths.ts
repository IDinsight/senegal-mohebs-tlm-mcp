/*
 * Module: kg-store · internal
 *
 * Dotted-path read/write over a node's `properties` bag — the exact semantics the
 * curriculum recipes (`reposition`, `set_content`) use to touch a node's ordinal
 * and load-bearing content. Kept as its own leaf so those helpers survive
 * independently of any one mutation.
 */

// Walk a dotted path over an object, returning the leaf value or undefined.
// Deliberately shallow — no array indexing, no bracket notation — since the
// paths in use are all dot-separated object keys.
export function readAtPath(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// Return a new object with the leaf at `path` set to `value`, without mutating
// any input. Intermediate objects along the path are cloned; siblings are
// structurally shared.
export function writeAtPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split(".");
  const clone = { ...obj };
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    const nextObj = next && typeof next === "object" && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
    cur[seg] = nextObj;
    cur = nextObj;
  }
  cur[segments[segments.length - 1]] = value;
  return clone;
}
