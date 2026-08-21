/*
 * Layer: services · module: translation
 *
 * A single pure function that asks Google Gemini to translate between French and
 * Wolof. It is deliberately subject-agnostic: the caller (the server tool group)
 * decides which glossary terms are relevant and passes them in as data, so this
 * module depends only on config — never on the curriculum/adapter layers.
 *
 * We call the Gemini REST endpoint with Node's built-in fetch (no SDK, no new
 * dependency) and ask for a JSON response so the model reports which direction
 * it detected alongside the translation.
 */
import { CONFIG } from "../config.js";

// "auto" lets Gemini detect the source language; the explicit forms pin it.
export type TranslateDirection = "auto" | "fr>wo" | "wo>fr";

// One glossary term as the curriculum knows it. `wolof` may be null when the
// glossary has a French headword but no Wolof equivalent yet.
export type GlossaryTerm = { francais: string; wolof: string | null };

export type TranslateInput = {
  text: string;
  direction?: TranslateDirection;
  glossary?: GlossaryTerm[];
};

export type TranslateResult = {
  translation: string;
  sourceLanguage: "French" | "Wolof";
  targetLanguage: "French" | "Wolof";
  model: string;
  glossaryTermsUsed: number;
};

// Human-readable direction instruction handed to the model.
const DIRECTION_INSTRUCTION: Record<TranslateDirection, string> = {
  auto: "Detect whether the input text is French or Wolof, then translate it into the other language.",
  "fr>wo": "The input text is French. Translate it into Wolof.",
  "wo>fr": "The input text is Wolof. Translate it into French.",
};

// The model must return exactly this shape, so the tool can report the detected
// direction without re-parsing free text.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    sourceLanguage: { type: "string", enum: ["French", "Wolof"] },
    targetLanguage: { type: "string", enum: ["French", "Wolof"] },
    translation: { type: "string" },
  },
  required: ["sourceLanguage", "targetLanguage", "translation"],
} as const;

// Render the glossary as a term bank the model should prefer over its own
// wording — this is what keeps translations consistent with existing materials.
function glossaryBlock(glossary: GlossaryTerm[]): string {
  const usable = glossary.filter((t) => t.wolof);
  if (usable.length === 0) return "";
  const lines = usable.map((t) => `- ${t.francais} = ${t.wolof}`).join("\n");
  return (
    "\n\nUse this curriculum glossary for any term that appears in it; prefer " +
    "these established French/Wolof equivalents over alternatives:\n" +
    lines
  );
}

function buildSystemInstruction(direction: TranslateDirection, glossary: GlossaryTerm[]): string {
  return (
    "You are a professional translator for Senegalese primary-school teaching " +
    "materials, fluent in French and Wolof. " +
    DIRECTION_INSTRUCTION[direction] +
    " Preserve meaning, register, and any formatting or numbering. Translate " +
    "only — do not explain or add commentary." +
    glossaryBlock(glossary)
  );
}

// Pull the model's text part out of a generateContent response, tolerating the
// candidates/parts nesting the REST API uses.
function extractText(payload: any): string {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p: any) => p?.text ?? "").join("");
}

export async function translate(input: TranslateInput): Promise<TranslateResult> {
  const text = input.text?.trim();
  if (!text) throw new Error("translate: `text` is empty.");
  if (!CONFIG.gemini.apiKey) throw new Error("translate: GEMINI_API_KEY is not configured on the server.");

  const direction = input.direction ?? "auto";
  const glossary = input.glossary ?? [];
  const { model, baseUrl, apiKey } = CONFIG.gemini;

  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: buildSystemInstruction(direction, glossary) }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  // The key travels in a header, never in the URL/query string.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`);
  }

  const raw = extractText(await res.json());
  let parsed: { sourceLanguage: string; targetLanguage: string; translation: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned a non-JSON translation payload: ${raw.slice(0, 300)}`);
  }

  return {
    translation: parsed.translation ?? "",
    sourceLanguage: parsed.sourceLanguage as TranslateResult["sourceLanguage"],
    targetLanguage: parsed.targetLanguage as TranslateResult["targetLanguage"],
    model,
    glossaryTermsUsed: glossary.filter((t) => t.wolof).length,
  };
}
