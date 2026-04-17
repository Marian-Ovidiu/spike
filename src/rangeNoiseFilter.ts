import type { EntryEvaluation } from "./entryConditions.js";

export function isPriorRangeTooWideForNormalEntry(
  entry: EntryEvaluation,
  maxPriorRangeForNormalEntry: number
): boolean {
  const threshold = Number.isFinite(maxPriorRangeForNormalEntry)
    ? Math.max(0, maxPriorRangeForNormalEntry)
    : 0.0015;
  return entry.priorRangeFraction > threshold;
}
