/*
 * Resolution-mapping test
 *
 * The task requires the (grade, subject) → adapter registry to permit
 * many-to-one — two different (grade, subject) pairs pointing at one adapter
 * builder — even if that isn't the case for any subject shipped today.
 *
 * The check uses `__registerAdapterForTest` to attach the SAME builder under
 * two synthetic keys, then asserts both resolve to adapters whose builder
 * output shares the same adapter id and deliverables. We deliberately do NOT
 * register these keys as part of listAvailableContexts (there are no source
 * folders for them) — the resolution mapping is source-independent by design.
 */
import { describe, it, expect, afterEach } from "vitest";
import { resolveAdapter, __registerAdapterForTest } from "./index.js";
import { buildCiMathsAdapter } from "./ci-maths.js";

const TEST_KEYS: Array<[string, string]> = [
  ["testgrade1", "testsubject"],
  ["testgrade2", "testsubject"],
];

describe("adapter resolution", () => {
  afterEach(() => {
    for (const [g, s] of TEST_KEYS) __registerAdapterForTest(g, s, null);
  });

  it("supports many-to-one: two (grade, subject) pairs can point at one adapter builder", () => {
    // Register the SAME builder under two synthetic keys, then resolve both.
    // A passing assertion here is the "explicit many-to-one" guarantee the
    // task requires — the registry is source-independent, so we don't need
    // to ship synthetic source folders to exercise it.
    for (const [g, s] of TEST_KEYS) __registerAdapterForTest(g, s, buildCiMathsAdapter);

    const [a1, a2] = TEST_KEYS.map(([g, s]) => resolveAdapter(g, s));
    expect(a1).toBeTruthy();
    expect(a2).toBeTruthy();
    // Both adapters share the CI maths adapter id and deliverable set — same
    // behavior module, bound to different (grade, subject) pairs.
    expect(a1!.id).toBe(a2!.id);
    expect(a1!.deliverables.map((d) => d.key)).toEqual(a2!.deliverables.map((d) => d.key));
    // Each carries its own (grade, subject) identity, though — the builder
    // takes them as arguments, so many-to-one doesn't collapse identities.
    expect(a1!.grade).toBe(TEST_KEYS[0][0]);
    expect(a2!.grade).toBe(TEST_KEYS[1][0]);
    expect(a1!.subject).toBe(TEST_KEYS[0][1]);
    expect(a2!.subject).toBe(TEST_KEYS[1][1]);
  });

  it("returns null for an unregistered (grade, subject)", () => {
    // Unregistered pair: unknown-context behavior is unchanged from today —
    // resolveAdapter returns null and activateContext surfaces a clear error.
    expect(resolveAdapter("no-such-grade", "no-such-subject")).toBeNull();
  });
});
