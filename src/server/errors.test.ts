/*
 * Typed tool-error tests (issue #3)
 *
 * `guarded` must turn a thrown error into a STRUCTURED { error: { code, message } }
 * envelope with isError set — never the bare, undifferentiated string that made
 * a store outage indistinguishable from a bad argument in live testing. Also
 * covers classifyError's store-vs-internal split and the debug-only stack.
 */
import { describe, it, expect, afterEach } from "vitest";
import { guarded } from "./shared.js";
import { classifyError, CodedError } from "../utils/index.js";
import { ContextNotSetError } from "../context/index.js";

const body = (r: { content: { type: string; text: string }[] }) => JSON.parse(r.content[0].text);

afterEach(() => { delete process.env.TLM_DEBUG; });

describe("guarded — structured typed errors", () => {
  it("wraps an unknown throw as INTERNAL_ERROR with isError and the real message", async () => {
    const h = guarded(async () => { throw new Error("something specific broke"); });
    const res = await h({});
    expect(res.isError).toBe(true);
    expect(body(res).error).toMatchObject({ code: "INTERNAL_ERROR", message: "something specific broke" });
  });

  it("classifies a datastore/transport failure as STORE_UNAVAILABLE", async () => {
    const h = guarded(async () => { throw new Error("GaxiosError: could not refresh default credentials"); });
    const res = await h({});
    expect(res.isError).toBe(true);
    expect(body(res).error.code).toBe("STORE_UNAVAILABLE");
  });

  it("passes a CodedError's code through verbatim", async () => {
    const h = guarded(async () => { throw new CodedError("NOT_FOUND", "no such node 'x'"); });
    const res = await h({});
    expect(body(res).error).toMatchObject({ code: "NOT_FOUND", message: "no such node 'x'" });
  });

  it("does NOT treat a missing context as an error — it prompts for one", async () => {
    const h = guarded(async () => { throw new ContextNotSetError([{ workspace: "senegal", grade: "ci", subject: "maths" }]); });
    const res = await h({});
    expect(res.isError).toBeFalsy();
    expect(body(res)).toMatchObject({ needsContext: true });
    expect(body(res).available).toEqual([{ workspace: "senegal", grade: "ci", subject: "maths" }]);
  });

  it("includes a stack only in debug mode", async () => {
    const throwing = guarded(async () => { throw new Error("boom"); });
    expect(body(await throwing({})).error.detail).toBeUndefined();
    process.env.TLM_DEBUG = "1";
    const dbg = body(await throwing({})).error;
    expect(dbg.detail).toBeDefined();
    expect(typeof dbg.detail.stack).toBe("string");
  });
});

describe("classifyError", () => {
  it("maps network error codes to STORE_UNAVAILABLE", () => {
    for (const m of ["ECONNRESET while reading", "socket hang up", "DEADLINE_EXCEEDED", "bucket not reachable"]) {
      expect(classifyError(new Error(m)).code).toBe("STORE_UNAVAILABLE");
    }
  });
  it("defaults an unrecognised error to INTERNAL_ERROR", () => {
    expect(classifyError(new Error("array index out of bounds")).code).toBe("INTERNAL_ERROR");
  });
});
