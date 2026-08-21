/*
 * The Gemini translation service, exercised against a stubbed fetch — we never
 * hit the real API. Verifies the request shape (key in a header, JSON response
 * requested, glossary + direction folded into the system instruction) and that
 * the model's JSON payload is parsed back into a TranslateResult.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CONFIG } from "../../config.js";
import { translate } from "../gemini.js";

// Capture the single generateContent call the service makes.
function stubGemini(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
  }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe("translate — Gemini FR↔Wolof service", () => {
  beforeEach(() => {
    CONFIG.gemini.apiKey = "test-key";
    CONFIG.gemini.model = "gemini-3.6-flash";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    CONFIG.gemini.apiKey = "";
  });

  it("sends the key in a header (never the URL) and asks for a JSON response", async () => {
    const fetchMock = stubGemini({ sourceLanguage: "French", targetLanguage: "Wolof", translation: "Nanga def" });
    await translate({ text: "Bonjour" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("gemini-3.6-flash:generateContent");
    expect(url).not.toContain("test-key"); // key must not leak into the URL
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("folds glossary terms and an explicit direction into the system instruction", async () => {
    const fetchMock = stubGemini({ sourceLanguage: "French", targetLanguage: "Wolof", translation: "..." });
    await translate({
      text: "Compte les objets.",
      direction: "fr>wo",
      glossary: [
        { francais: "compter", wolof: "waññ" },
        { francais: "objet", wolof: null }, // no Wolof yet → excluded from the term bank
      ],
    });

    const init = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init[1].body as string);
    const instruction = body.systemInstruction.parts[0].text as string;
    expect(instruction).toContain("The input text is French. Translate it into Wolof.");
    expect(instruction).toContain("compter = waññ");
    expect(instruction).not.toContain("objet ="); // null-Wolof term is dropped
  });

  it("parses the model's JSON payload into a TranslateResult", async () => {
    stubGemini({ sourceLanguage: "Wolof", targetLanguage: "French", translation: "Bonjour" });
    const result = await translate({ text: "Nanga def", glossary: [{ francais: "compter", wolof: "waññ" }] });

    expect(result).toMatchObject({
      translation: "Bonjour",
      sourceLanguage: "Wolof",
      targetLanguage: "French",
      model: "gemini-3.6-flash",
      glossaryTermsUsed: 1,
    });
  });

  it("refuses when no API key is configured", async () => {
    CONFIG.gemini.apiKey = "";
    await expect(translate({ text: "Bonjour" })).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it("surfaces a non-2xx Gemini response as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => "quota" })) as unknown as typeof fetch,
    );
    await expect(translate({ text: "Bonjour" })).rejects.toThrow(/429/);
  });
});
