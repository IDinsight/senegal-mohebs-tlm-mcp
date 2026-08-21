/*
 * Layer: services · module: translation — barrel.
 *
 * Gemini-backed FR↔Wolof translation. The server layer imports only from here.
 */
export { translate } from "./gemini.js";
export type { TranslateDirection, TranslateInput, TranslateResult, GlossaryTerm } from "./gemini.js";
