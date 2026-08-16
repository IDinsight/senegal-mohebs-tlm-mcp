/*
 * Universal response-size backstop — asJson / asResource
 *
 * The last line of defence: no tool response, whatever its shape, may exceed the
 * byte cap. Under the cap a payload passes through verbatim; over it, it is
 * REPLACED by a small RESPONSE_TOO_LARGE envelope (isError) carrying the byte
 * math + a one-level shape so the caller sees what overflowed and how to narrow.
 */
import { describe, it, expect, afterEach } from "vitest";
import { asJson, asResource, asText } from "../server.js";

const textOf = (r: { content: Array<{ type: string; text?: string; resource?: { text: string } }> }) => {
  const block = r.content[0];
  return block.type === "text" ? block.text! : block.resource!.text;
};
const body = (r: Parameters<typeof textOf>[0]) => JSON.parse(textOf(r));

afterEach(() => { delete process.env.TLM_MAX_RESPONSE_BYTES; });

describe("asJson response cap", () => {
  it("passes a small payload through unchanged (single text block, no isError)", () => {
    const res = asJson({ hello: "world", n: 1 });
    expect(res.isError).toBeFalsy();
    expect(body(res)).toEqual({ hello: "world", n: 1 });
  });

  it("replaces an oversized payload with a RESPONSE_TOO_LARGE envelope", () => {
    process.env.TLM_MAX_RESPONSE_BYTES = "500";
    const big = { roots: Array.from({ length: 1000 }, (_u, i) => ({ id: `n${i}` })), note: "x".repeat(50) };
    const res = asJson(big);
    expect(res.isError).toBe(true);
    const parsed = body(res);
    expect(parsed.error.code).toBe("RESPONSE_TOO_LARGE");
    expect(parsed.error.cap).toBe(500);
    expect(parsed.error.bytes).toBeGreaterThan(500);
    expect(typeof parsed.hint).toBe("string");
  });

  it("reports a one-level shape so the caller sees WHAT overflowed", () => {
    process.env.TLM_MAX_RESPONSE_BYTES = "500";
    const res = asJson({ roots: Array.from({ length: 1000 }, () => 0), name: "hi", meta: { a: 1, b: 2 } });
    const parsed = body(res);
    expect(parsed.shape.roots).toBe("array(1000)");
    expect(parsed.shape.name).toBe("string(2 chars)");
    expect(parsed.shape.meta).toBe("object(2 keys)");
  });

  it("the oversize envelope itself is small (well under the cap)", () => {
    process.env.TLM_MAX_RESPONSE_BYTES = "500";
    const res = asJson({ roots: Array.from({ length: 100000 }, (_u, i) => ({ id: `node-${i}`, big: "y".repeat(20) })) });
    expect(Buffer.byteLength(textOf(res), "utf8")).toBeLessThan(2000);
  });

  it("honours the default cap (~100 KB) when no override is set", () => {
    const justUnder = { blob: "z".repeat(90 * 1024) };   // ~90 KB < 100 KB default
    expect(asJson(justUnder).isError).toBeFalsy();
    const over = { blob: "z".repeat(120 * 1024) };        // ~120 KB > 100 KB default
    expect(asJson(over).isError).toBe(true);
  });
});

describe("asResource / asText response cap", () => {
  it("passes a small resource through as a resource block with its mimeType", () => {
    const res = asText("tlm://doc/a.txt", "short body");
    expect(res.isError).toBeFalsy();
    expect(res.content[0]).toMatchObject({ type: "resource", resource: { mimeType: "text/plain", text: "short body" } });
  });

  it("replaces an oversized resource with the RESPONSE_TOO_LARGE envelope", () => {
    process.env.TLM_MAX_RESPONSE_BYTES = "500";
    const res = asResource("tlm://doc/big.txt", "text/plain", "w".repeat(5000));
    expect(res.isError).toBe(true);
    expect(body(res).error.code).toBe("RESPONSE_TOO_LARGE");
  });
});
