import type { WindowSpikeResult } from "./strategy.js";

export type MovementClassification = "no_signal" | "borderline" | "strong_spike";

export type MovementAnalysis = {
  strongestMovePercent: number;
  strongestMoveAbsolute: number;
  strongestMoveDirection: "UP" | "DOWN" | null;
  thresholdPercent: number;
  thresholdRatio: number;
  classification: MovementClassification;
  sourceWindowLabel: string | null;
};

export function toMovementAnalysis(windowSpike: WindowSpikeResult): MovementAnalysis {
  return {
    strongestMovePercent: windowSpike.strongestMovePercent,
    strongestMoveAbsolute: windowSpike.strongestMoveAbsolute,
    strongestMoveDirection: windowSpike.strongestMoveDirection,
    thresholdPercent: windowSpike.thresholdPercent,
    thresholdRatio: windowSpike.thresholdRatio,
    classification: windowSpike.classification,
    sourceWindowLabel: windowSpike.sourceWindowLabel,
  };
}

export function isStrongSpikeClassification(
  classification: MovementClassification
): boolean {
  return classification === "strong_spike";
}

