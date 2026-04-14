import {
  analyzePostBorderlineMovement,
  type BorderlineCandidate,
  type PostBorderlineMovementAnalysis,
} from "./borderlineCandidate.js";

export type PostMoveAnalyzerInput = {
  candidate: BorderlineCandidate;
  watchedTickPrices: readonly number[];
  continuationThreshold: number;
  reversionThreshold: number;
  pauseBandPercent: number;
};

/**
 * Shared wrapper so post-move interpretation can evolve without touching callers.
 */
export function analyzeBorderlinePostMove(
  input: PostMoveAnalyzerInput
): PostBorderlineMovementAnalysis {
  return analyzePostBorderlineMovement(input.candidate, input.watchedTickPrices, {
    continuationThreshold: input.continuationThreshold,
    reversionThreshold: input.reversionThreshold,
    pauseBandPercent: input.pauseBandPercent,
  });
}
