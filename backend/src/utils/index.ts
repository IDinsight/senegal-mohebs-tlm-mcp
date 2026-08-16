/*
 * Public surface of the utils module. Import shared helpers from here.
 */
export { noAccents, slug, firstInt } from "./strings.js";
export { asJson, asResource, asMarkdown, asText, buildConfirmEnvelope, CodedError, classifyError, toolError, isDebug } from "./server.js";
export type { ToolResult, ConfirmationEnvelope, ToolErrorCode } from "./server.js";
export { installProcessGuards } from "./process.js";
