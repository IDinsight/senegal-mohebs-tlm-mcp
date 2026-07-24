// Public surface of the curriculum module: the normalized-model builder, the
// FR/Wolof terminology lookups, and the per-subject graph adapters. Raw-graph
// parsing lives in adapters/* and is only exposed as adapter/curriculum objects.
export { buildModel, unit } from "./model.js";
export { searchTerminology, terminologySections } from "./terminology.js";
export { mathsAdapter, createMathsCurriculum } from "./adapters/maths.js";
export { readingAdapter, createReadingCurriculum } from "./adapters/reading.js";
