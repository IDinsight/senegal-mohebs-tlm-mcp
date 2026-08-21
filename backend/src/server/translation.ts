/*
 * Module: server · tool group: translation
 *
 * `translate` — FR↔Wolof translation backed by Google Gemini (which reads Wolof
 * more reliably than our in-house models). It is grounded in the active
 * subject's MOHEBS glossary: we scan the passage for terms the curriculum
 * already fixes a Wolof wording for and hand those to Gemini as a term bank, so
 * translations stay consistent with existing materials. This is generative
 * translation — distinct from `get_terminology`, which only looks up terms that
 * already exist in the glossary.
 *
 * Guarded like the other curriculum reads: it needs an active grade/subject to
 * resolve the glossary. It never touches the KG store or Cloud Storage.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asJson, guarded } from "./shared.js";
import { CONFIG } from "../config.js";
import { effectiveTerms, filterByText } from "./glossary-read.js";
import { translate, type TranslateDirection } from "../translation/index.js";

export function registerTranslationTools(server: McpServer) {
  server.registerTool(
    "translate",
    {
      title: "Translate French ↔ Wolof (Gemini)",
      description:
        "Translate text between French and Wolof using Google Gemini, grounded in the active subject's MOHEBS FR/Wolof glossary (relevant terms are passed to the model as a term bank so wording stays consistent with existing materials). Direction defaults to auto-detect; pass 'fr>wo' or 'wo>fr' to pin it. Unlike get_terminology (glossary lookup only), this generates a full translation. Requires an active grade/subject and a server-side Gemini API key.",
      inputSchema: {
        text: z.string().describe("The passage to translate."),
        direction: z
          .enum(["auto", "fr>wo", "wo>fr"])
          .optional()
          .describe("Translation direction. Default: auto (Gemini detects the source language)."),
      },
    },
    guarded(async (a: { text: string; direction?: TranslateDirection }) => {
      if (!CONFIG.gemini.apiKey) {
        return asJson({
          unavailable: true,
          message:
            "Translation is unavailable: the server has no GEMINI_API_KEY configured. Set it (as a deployment secret) to enable the translate tool.",
        });
      }
      // Term bank: workspace lexicon entries whose wording appears in this passage.
      const glossary = filterByText(await effectiveTerms(), a.text, 40).map((e) => ({ francais: e.francais, wolof: e.wolof }));
      const result = await translate({ text: a.text, direction: a.direction ?? "auto", glossary });
      return asJson(result);
    }),
  );
}
