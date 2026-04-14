import {
  buildPromotedEntryEvaluation,
  evaluateBorderlineWatchDecision,
  type EvaluateBorderlineWatchInput,
} from "./borderlineCandidate.js";

/**
 * Watch-phase decision entrypoint shared by live and backtest strategy flows.
 */
export function decideBorderlineWatch(input: EvaluateBorderlineWatchInput) {
  return evaluateBorderlineWatchDecision(input);
}

/**
 * Converts a promoted borderline candidate into an executable entry payload.
 */
export function buildBorderlinePromotedEntry(
  ...args: Parameters<typeof buildPromotedEntryEvaluation>
) {
  return buildPromotedEntryEvaluation(...args);
}
