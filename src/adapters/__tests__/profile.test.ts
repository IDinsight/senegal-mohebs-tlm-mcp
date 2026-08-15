/*
 * SubjectProfile schema + generic builder.
 *
 * Phase 2 of the authorable catalog moves each subject from a hand-written
 * behavior module to a declarative profile read by one generic builder. That
 * trade only holds if a malformed profile fails LOUDLY at the boundary (the
 * design note's "runtime vs compile-time validation" risk) — so these tests pin
 * the guard, plus the synthesized bit a reviewer can't see by eye: the
 * capability-gated domain-rotation helpers.
 */
import { describe, it, expect } from "vitest";
import { validateProfile, type SubjectProfile } from "../profile.js";
import { buildAdapterFromProfile } from "../build.js";
import { CI_MATHS_PROFILE } from "../profiles/ci-maths.js";
import { CE1_READING_PROFILE } from "../profiles/ce1-reading.js";
import { NIGERIA_MATHS_PROFILE } from "../profiles/nigeria-maths.js";

describe("SubjectProfile validation", () => {
  it("accepts every shipped profile", () => {
    for (const p of [CI_MATHS_PROFILE, CE1_READING_PROFILE, NIGERIA_MATHS_PROFILE]) {
      expect(() => validateProfile(p)).not.toThrow();
    }
  });

  it("rejects an out-of-range numberFrom", () => {
    const bad = { ...CI_MATHS_PROFILE, parse: { ...CI_MATHS_PROFILE.parse, numberFrom: "ordinal" } };
    expect(() => validateProfile(bad)).toThrow(/numberFrom/);
  });

  it("rejects unknown top-level keys (strict) so a typo can't silently no-op", () => {
    const bad = { ...CI_MATHS_PROFILE, capabilties: {} }; // misspelled
    expect(() => validateProfile(bad)).toThrow();
  });
});

describe("buildAdapterFromProfile — synthesized behavior", () => {
  it("attaches the domain-rotation helpers only when the capability is on", () => {
    const maths = buildAdapterFromProfile(CI_MATHS_PROFILE, "ci", "maths");
    const reading = buildAdapterFromProfile(CE1_READING_PROFILE, "ce1", "reading");
    expect(typeof maths.suggestFreshDomain).toBe("function"); // exampleDomainRotation: true
    expect(reading.suggestFreshDomain).toBeUndefined();       // exampleDomainRotation: false
  });
});
