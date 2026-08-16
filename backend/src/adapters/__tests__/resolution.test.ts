/*
 * Resolution-mapping test
 *
 * The task requires the (grade, subject) → adapter registry to permit
 * many-to-one — two different (grade, subject) pairs pointing at one adapter
 * builder — even if that isn't the case for any subject shipped today.
 *
 * The check uses `__registerProfileForTest` to attach the SAME profile under
 * two synthetic keys, then asserts both resolve to adapters whose builder
 * output shares the same adapter id and capabilities. We deliberately do NOT
 * register these keys as part of listAvailableContexts (there are no source
 * folders for them) — the resolution mapping is source-independent by design.
 */
import { describe, it, expect, afterEach } from "vitest";
import { resolveAdapter, __registerProfileForTest } from "../index.js";
import { CI_MATHS_PROFILE } from "../profiles/ci-maths.js";

const TEST_KEYS: Array<[string, string]> = [
  ["testgrade1", "testsubject"],
  ["testgrade2", "testsubject"],
];

describe("adapter resolution", () => {
  afterEach(() => {
    for (const [grade, subject] of TEST_KEYS) __registerProfileForTest(grade, subject, null);
  });

  it("supports many-to-one: two (grade, subject) pairs can share one profile", () => {
    // Register the SAME profile under two synthetic keys, then resolve both.
    // A passing assertion here is the "explicit many-to-one" guarantee the
    // task requires — the registry is source-independent, so we don't need
    // to ship synthetic source folders to exercise it.
    for (const [grade, subject] of TEST_KEYS) __registerProfileForTest(grade, subject, CI_MATHS_PROFILE);

    const [adapter1, adapter2] = TEST_KEYS.map(([grade, subject]) => resolveAdapter(grade, subject));
    expect(adapter1).toBeTruthy();
    expect(adapter2).toBeTruthy();
    // Both adapters are built from the same CI maths profile — same adapter id
    // and capabilities, bound to different (grade, subject) pairs.
    expect(adapter1!.id).toBe(adapter2!.id);
    expect(adapter1!.capabilities).toEqual(adapter2!.capabilities);
    // Each carries its own (grade, subject) identity, though — the builder
    // takes them as arguments, so many-to-one doesn't collapse identities.
    expect(adapter1!.grade).toBe(TEST_KEYS[0][0]);
    expect(adapter2!.grade).toBe(TEST_KEYS[1][0]);
    expect(adapter1!.subject).toBe(TEST_KEYS[0][1]);
    expect(adapter2!.subject).toBe(TEST_KEYS[1][1]);
  });

  it("returns null for an unregistered (grade, subject)", () => {
    // Unregistered pair: unknown-context behavior is unchanged from today —
    // resolveAdapter returns null and activateContext surfaces a clear error.
    expect(resolveAdapter("no-such-grade", "no-such-subject")).toBeNull();
  });
});
