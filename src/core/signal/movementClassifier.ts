import {
  detectWindowSpike,
  type SpikeBand,
  type SpikeWindowResult,
} from "./spikeDetection.js";

export type MovementClassifierInput = {
  prices: readonly number[];
  spikeThreshold: number;
  borderlineMinRatio: number;
  windowTicks?: number;
};

/** Classifies the rolling window using shared threshold logic. */
export function classifyMovementWindow(
  input: MovementClassifierInput
): SpikeWindowResult {
  return detectWindowSpike(
    input.prices,
    input.spikeThreshold,
    input.windowTicks ?? 2,
    input.borderlineMinRatio
  );
}

export function isStrongSpikeBand(band: SpikeBand): boolean {
  return band === "strong_spike";
}

export function isBorderlineBand(band: SpikeBand): boolean {
  return band === "borderline";
}
