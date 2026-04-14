import { detectStableRangePriorToLast } from "./strategy.js";

export type StableRangeQuality = "good" | "acceptable" | "poor";

export type StableRangeAssessment = {
  stableRangeDetected: boolean;
  priorRangePercent: number;
  stableRangeQuality: StableRangeQuality;
};

function priorRangeFraction(prices: readonly number[]): number {
  const priorWindow = prices.slice(0, -1);
  if (priorWindow.length < 2) return 0;
  const max = Math.max(...priorWindow);
  const min = Math.min(...priorWindow);
  if (!(min > 0 && Number.isFinite(min) && Number.isFinite(max))) {
    return Number.POSITIVE_INFINITY;
  }
  return (max - min) / min;
}

/**
 * Soft range-quality assessment for pre-spike context.
 * - good: strict stable range passes and prior range is comfortably below threshold
 * - acceptable: strict stable fails but still within soft tolerance
 * - poor: prior range is too wide/noisy
 */
export function assessStableRangeQuality(input: {
  prices: readonly number[];
  rangeThreshold: number;
  stableRangeSoftToleranceRatio: number;
  goodClearBelowRatio?: number;
}): StableRangeAssessment {
  const priorFraction = priorRangeFraction(input.prices);
  const stable = detectStableRangePriorToLast(input.prices, input.rangeThreshold);
  const clearBelowRatio = input.goodClearBelowRatio ?? 0.8;
  const goodCap = input.rangeThreshold * Math.max(0, clearBelowRatio);
  const acceptableCap =
    input.rangeThreshold * Math.max(1, input.stableRangeSoftToleranceRatio);

  let quality: StableRangeQuality = "poor";
  if (stable && priorFraction <= goodCap) {
    quality = "good";
  } else if (priorFraction <= acceptableCap) {
    quality = "acceptable";
  }

  return {
    stableRangeDetected: stable,
    priorRangePercent: Number.isFinite(priorFraction) ? priorFraction * 100 : 0,
    stableRangeQuality: quality,
  };
}
