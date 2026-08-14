/*
 * SubjectProfile schema + generic builder.
 *
 * Phase 2 of the authorable catalog moves each subject from a hand-written
 * behavior module to a declarative profile read by one generic builder. That
 * trade only holds if a malformed profile fails LOUDLY at the boundary (the
 * design note's "runtime vs compile-time validation" risk) — so these tests pin
 * the guard, plus the two synthesized bits a reviewer can't see by eye: the
 * deliverable `classify` complement and the optional coverage hook.
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

  it("rejects an unknown coverage rule, naming the offending path", () => {
    const bad = { ...CI_MATHS_PROFILE, coverage: [{ rule: "no-such-rule", kinds: ["chapter"] }] };
    expect(() => validateProfile(bad, "profile for ci/maths")).toThrow(/profile for ci\/maths/);
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
  it("a 'default' deliverable matches iff no specific deliverable does (the maths complement)", () => {
    const a = buildAdapterFromProfile(CI_MATHS_PROFILE, "ci", "maths");
    const classify = (f: string) => a.deliverables.find((d) => d.classify(f))?.key;
    // A teacher-guide filename hits the specific "lessons" matcher (accent/
    // case-insensitive); anything else falls to the "manual" default.
    expect(classify("Fiches de leçons - Chapitre 1.docx")).toBe("lessons");
    expect(classify("FICHE DE LECON 3.docx")).toBe("lessons");
    expect(classify("Manuel eleve chapitre 1.docx")).toBe("manual");
  });

  it("omits the coverage hook when the profile declares no rules (Nigeria)", () => {
    const withCoverage = buildAdapterFromProfile(CI_MATHS_PROFILE, "ci", "maths");
    const without = buildAdapterFromProfile(NIGERIA_MATHS_PROFILE, "primary-1-3", "maths");
    expect(typeof withCoverage.coverageWarnings).toBe("function");
    expect(without.coverageWarnings).toBeUndefined();
  });

  it("attaches the domain-rotation helpers only when the capability is on", () => {
    const maths = buildAdapterFromProfile(CI_MATHS_PROFILE, "ci", "maths");
    const reading = buildAdapterFromProfile(CE1_READING_PROFILE, "ce1", "reading");
    expect(typeof maths.suggestFreshDomain).toBe("function"); // exampleDomainRotation: true
    expect(reading.suggestFreshDomain).toBeUndefined();       // exampleDomainRotation: false
  });
});
