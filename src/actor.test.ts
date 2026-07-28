import { describe, it, expect } from "vitest";
import { resolveActor, runAsActor, currentActor, UNKNOWN_ACTOR } from "./actor.js";

describe("resolveActor — verified token → identity", () => {
  it("maps JWT claims from req.auth.extra to an Actor", () => {
    const a = resolveActor({
      extra: { sub: "u_42", email: "u@example.org", iss: "https://issuer.example/auth/v1" },
    });
    expect(a.id).toBe("u_42");
    expect(a.email).toBe("u@example.org");
    expect(a.tokenIssuer).toBe("https://issuer.example/auth/v1");
    expect(a.unknown).toBe(false);
  });

  it("populates only what the token provides (email / iss are optional)", () => {
    const a = resolveActor({ extra: { sub: "u_1" } });
    expect(a.id).toBe("u_1");
    expect(a.email).toBeUndefined();
    expect(a.tokenIssuer).toBeUndefined();
    expect(a.unknown).toBe(false);
  });
});

describe("resolveActor — missing / invalid → unknown", () => {
  it("no auth at all (unauthenticated request) → UNKNOWN_ACTOR", () => {
    expect(resolveActor(undefined)).toEqual(UNKNOWN_ACTOR);
  });

  it("auth present but no sub → UNKNOWN_ACTOR", () => {
    expect(resolveActor({ extra: {} })).toEqual(UNKNOWN_ACTOR);
  });

  it("empty-string sub → UNKNOWN_ACTOR (defensive; never fabricates an id)", () => {
    expect(resolveActor({ extra: { sub: "" } })).toEqual(UNKNOWN_ACTOR);
  });

  it("non-string claim shapes are rejected wholesale", () => {
    // Simulate a hostile / malformed auth object. resolveActor must not
    // coerce these into an identity.
    expect(resolveActor({ extra: { sub: 123 as unknown as string } }).unknown).toBe(true);
    expect(resolveActor({ extra: { sub: null as unknown as string } }).unknown).toBe(true);
    // sub is valid but email/iss are not strings → drop them, don't crash.
    const a = resolveActor({
      extra: { sub: "u_ok", email: {} as unknown as string, iss: 7 as unknown as string },
    });
    expect(a.unknown).toBe(false);
    expect(a.id).toBe("u_ok");
    expect(a.email).toBeUndefined();
    expect(a.tokenIssuer).toBeUndefined();
  });
});

describe("runAsActor / currentActor — request scoping", () => {
  it("currentActor() outside any run returns UNKNOWN_ACTOR", () => {
    expect(currentActor()).toEqual(UNKNOWN_ACTOR);
  });

  it("currentActor() inside runAsActor sees the exact actor that was set", () => {
    const actor = { id: "u_1", email: "e@x", tokenIssuer: "i", unknown: false };
    let seen: unknown;
    runAsActor(actor, () => { seen = currentActor(); });
    expect(seen).toEqual(actor);
  });

  it("actor is scoped: the store does not leak past the run", () => {
    runAsActor({ id: "u_1", unknown: false }, () => {
      expect(currentActor().id).toBe("u_1");
    });
    expect(currentActor()).toEqual(UNKNOWN_ACTOR);
  });
});

describe("spoofing — tool arguments cannot influence the actor", () => {
  // The actor is derived exclusively from the verified auth object. The
  // resolveActor surface takes only that object — there is no code path that
  // merges tool arguments, headers, or JSON-RPC body fields into an Actor.
  // These tests exercise the shape of what a hostile client would try.

  it("a malicious tool call cannot promote an unauthenticated request to an identity", () => {
    // Simulate a JSON-RPC "tools/call" with a hostile arguments blob AND no
    // verified auth (as would be the case in an ALLOW_UNAUTHENTICATED run).
    const hostileToolCall = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "set_context",
        arguments: {
          grade: "ci", subject: "maths",
          // Every plausible spoof vector a client might try:
          actor: { id: "admin", email: "admin@x", unknown: false },
          actor_id: "admin",
          sub: "admin",
          email: "admin@x",
          role: "curator",
          _auth: { sub: "admin" },
        },
      },
      id: 1,
    };
    const noVerifiedAuth = undefined;

    // resolveActor is the ONLY writer for actor state, and it reads only the
    // verified auth object — hostileToolCall is not even an input.
    const actor = resolveActor(noVerifiedAuth);
    expect(actor).toEqual(UNKNOWN_ACTOR);

    runAsActor(actor, () => {
      // A tool handler reading currentActor() sees "unknown" regardless of
      // what the arguments claim.
      expect(currentActor().id).toBe("unknown");
      expect(currentActor().unknown).toBe(true);
      // And the hostile fields are inert data — present but never consulted.
      expect(hostileToolCall.params.arguments.actor_id).toBe("admin");
    });
  });

  it("verified identity wins over any override attempted via args", () => {
    const verifiedAuth = {
      extra: { sub: "user_real", email: "real@x", iss: "https://issuer.example/auth/v1" },
    };
    const hostileArgs = { actor_id: "user_attacker", email: "attacker@x", sub: "user_attacker" };

    const actor = resolveActor(verifiedAuth);
    expect(actor.id).toBe("user_real");
    expect(actor.email).toBe("real@x");
    expect(actor.unknown).toBe(false);

    runAsActor(actor, () => {
      expect(currentActor().id).toBe("user_real");
      expect(currentActor().email).toBe("real@x");
      // Hostile args untouched, and by design never consulted.
      expect(hostileArgs.actor_id).toBe("user_attacker");
    });
  });
});
