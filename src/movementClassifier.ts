import {
  detectWindowSpike,
  type MovementClassification,
  type WindowSpikeResult,
} from "./strategy.js";

export type MovementClassifierInput = {
  prices: readonly number[];
  spikeThreshold: number;
  borderlineMinRatio: number;
  windowTicks?: number;
};

/**
 * Central movement classifier used by both live and backtest paths.
 * Keeps window-based threshold logic in one place.
 */
export function classifyMovementWindow(
  input: MovementClassifierInput
): WindowSpikeResult {
  return detectWindowSpike(
    input.prices,
    input.spikeThreshold,
    input.windowTicks ?? 2,
    input.borderlineMinRatio
  );
}

export function isStrongSpike(classification: MovementClassification): boolean {
  return classification === "strong_spike";
}

export function isBorderline(classification: MovementClassification): boolean {
  return classification === "borderline";
}
