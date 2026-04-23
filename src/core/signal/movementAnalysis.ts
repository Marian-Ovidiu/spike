import type { SpikeBand, SpikeWindowResult } from "./spikeDetection.js";
import type { SignalDirection, SignalMovementSummary, SignalStrength } from "./types.js";

/** Maps internal spike band to neutral strength tier. */
export function spikeBandToStrength(band: SpikeBand): SignalStrength {
  if (band === "strong_spike") return "strong";
  if (band === "borderline") return "borderline";
  return "none";
}

export function summarizeMovement(windowSpike: SpikeWindowResult): SignalMovementSummary {
  return {
    strongestMoveFraction: windowSpike.strongestMoveFraction,
    strongestMoveAbsolute: windowSpike.strongestMoveAbsolute,
    impulseDirection: windowSpike.impulseDirection,
    thresholdFraction: windowSpike.thresholdFraction,
    thresholdRatio: windowSpike.thresholdRatio,
    strength: spikeBandToStrength(windowSpike.band),
    referenceWindowLabel: windowSpike.sourceWindowLabel,
  };
}

/** Mean-reversion bias: fade the impulse. */
export function contrarianDirectionFromImpulse(
  impulse: SignalDirection
): SignalDirection {
  if (impulse === "up") return "down";
  if (impulse === "down") return "up";
  return "none";
}
