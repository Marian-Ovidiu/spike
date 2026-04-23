import {
  isMoveDominantVsChop,
  type SpikeWindowResult,
} from "./spikeDetection.js";
import {
  classifyMovementWindow,
  isStrongSpikeBand,
} from "./movementClassifier.js";
import { assessStableRangeQuality } from "./rangeStability.js";
import {
  contrarianDirectionFromImpulse,
  spikeBandToStrength,
  summarizeMovement,
} from "./movementAnalysis.js";
import type {
  SignalEvaluation,
  SignalMovementSummary,
  SignalRejectionReason,
  SignalWindowComparison,
  SignalWindowSnapshot,
} from "./types.js";

export const SIGNAL_GATE_CODES = {
  MARKET_NOT_STABLE: "prior_window_not_stable",
  RANGE_TOO_NOISY: "range_too_noisy",
  SPIKE_NOT_STRONG_ENOUGH: "spike_below_threshold",
  NO_DIRECTIONAL_MOVE: "no_directional_move",
  BORDERLINE_REJECTED_WEAK: "borderline_below_tradability",
} as const satisfies Record<string, SignalRejectionReason>;

export type EvaluateSignalConditionsInput = {
  prices: readonly number[];
  rangeThreshold: number;
  stableRangeSoftToleranceRatio: number;
  strongSpikeHardRejectPoorRange: boolean;
  spikeThreshold: number;
  spikeMinRangeMultiple: number;
  borderlineMinRatio: number;
  tradableSpikeMinPercent: number;
};

function toWindowSnapshot(windowSpike: SpikeWindowResult): SignalWindowSnapshot {
  const comps: SignalWindowComparison[] = windowSpike.comparisons.map((c) => ({
    referenceKind: c.source,
    referencePrice: c.referencePrice,
    relativeMove: c.relativeMove,
    absoluteDelta: c.absoluteDelta,
    exceedsThreshold: c.exceeds,
  }));

  return {
    strength: spikeBandToStrength(windowSpike.band),
    strongestMoveFraction: windowSpike.strongestMoveFraction,
    strongestMoveAbsolute: windowSpike.strongestMoveAbsolute,
    impulseDirection: windowSpike.impulseDirection,
    thresholdFraction: windowSpike.thresholdFraction,
    thresholdRatio: windowSpike.thresholdRatio,
    referenceWindowLabel: windowSpike.sourceWindowLabel,
    borderlineMinRatio: windowSpike.borderlineMinRatio,
    detectedStrongWindow: windowSpike.detectedStrongWindow,
    currentSample: windowSpike.currentSample,
    referencePrice: windowSpike.referencePrice,
    comparisons: comps,
  };
}

/**
 * Pure signal path: rolling prices, range quality, window spike, chop dominance.
 * Does **not** use execution quotes, spread, or venue-specific semantics.
 */
export function evaluateSignalConditions(
  input: EvaluateSignalConditionsInput
): SignalEvaluation {
  const {
    prices,
    rangeThreshold,
    stableRangeSoftToleranceRatio,
    strongSpikeHardRejectPoorRange,
    spikeThreshold,
    spikeMinRangeMultiple,
    borderlineMinRatio,
    tradableSpikeMinPercent,
  } = input;

  const rangeAssessment = assessStableRangeQuality({
    prices,
    rangeThreshold,
    stableRangeSoftToleranceRatio,
  });

  const rawWindowSpike = classifyMovementWindow({
    prices,
    spikeThreshold,
    borderlineMinRatio,
    windowTicks: 2,
  });

  const borderlineMinTradableMove = tradableSpikeMinPercent * 1.2;
  let windowSpike = rawWindowSpike;
  let borderlineDemotedWeak = false;

  if (rawWindowSpike.band === "borderline") {
    const ratioOk = rawWindowSpike.thresholdRatio >= borderlineMinRatio;
    const spikeFracOk =
      rawWindowSpike.strongestMoveFraction >= borderlineMinTradableMove;
    if (!ratioOk || !spikeFracOk) {
      borderlineDemotedWeak = true;
      windowSpike = {
        ...rawWindowSpike,
        band: "no_signal",
        detectedStrongWindow: false,
      };
    }
  }

  if (borderlineDemotedWeak) {
    const movementWeak: SignalMovementSummary = summarizeMovement(windowSpike);
    const rangeAssessmentWeak = assessStableRangeQuality({
      prices,
      rangeThreshold,
      stableRangeSoftToleranceRatio,
    });
    return {
      actionable: false,
      impulseDirection: windowSpike.impulseDirection,
      contrarianDirection: "none",
      strength: spikeBandToStrength(windowSpike.band),
      rejections: [SIGNAL_GATE_CODES.BORDERLINE_REJECTED_WEAK],
      stableRangeDetected: rangeAssessmentWeak.stableRangeDetected,
      priorRangeFraction: rangeAssessmentWeak.priorRangeFraction,
      stableRangeQuality: rangeAssessmentWeak.stableRangeQuality,
      rangeDecisionNote:
        "borderline demoted: below tightened tradability gate",
      spikeDetected: false,
      movement: movementWeak,
      window: toWindowSnapshot(windowSpike),
    };
  }

  const priorWindow = prices.slice(0, -1);
  const movement = summarizeMovement(windowSpike);
  const contextuallyStrong =
    isStrongSpikeBand(windowSpike.band) &&
    isMoveDominantVsChop(
      windowSpike.strongestMove,
      priorWindow,
      spikeMinRangeMultiple,
      spikeThreshold
    );
  const spikeDetected = isStrongSpikeBand(windowSpike.band);
  if (spikeDetected && !windowSpike.detectedStrongWindow) {
    throw new Error(
      "Invariant: strong_spike band must set detectedStrongWindow=true"
    );
  }

  const gateReasons: SignalRejectionReason[] = [];
  const veryStrongOverride =
    spikeDetected && windowSpike.thresholdRatio >= 1.8;
  if (spikeDetected) {
    if (
      strongSpikeHardRejectPoorRange &&
      rangeAssessment.stableRangeQuality === "poor"
    ) {
      gateReasons.push(SIGNAL_GATE_CODES.RANGE_TOO_NOISY);
    }
  } else {
    if (!contextuallyStrong) {
      gateReasons.push(SIGNAL_GATE_CODES.SPIKE_NOT_STRONG_ENOUGH);
    }
    if (rangeAssessment.stableRangeQuality === "poor" && !veryStrongOverride) {
      gateReasons.push(SIGNAL_GATE_CODES.RANGE_TOO_NOISY);
    } else if (
      !rangeAssessment.stableRangeDetected &&
      rangeAssessment.stableRangeQuality === "acceptable"
    ) {
      gateReasons.push(SIGNAL_GATE_CODES.MARKET_NOT_STABLE);
    }
  }

  const rangeDecisionNote =
    rangeAssessment.stableRangeQuality === "good"
      ? "strict stable range confirmed"
      : rangeAssessment.stableRangeQuality === "acceptable"
        ? "range acceptable despite missing strict stable-range rule"
        : veryStrongOverride
          ? "very strong spike override despite poor range"
          : "range too noisy for entry";

  if (gateReasons.length > 0) {
    return {
      actionable: false,
      impulseDirection: windowSpike.impulseDirection,
      contrarianDirection: "none",
      strength: spikeBandToStrength(windowSpike.band),
      rejections: gateReasons,
      stableRangeDetected: rangeAssessment.stableRangeDetected,
      priorRangeFraction: rangeAssessment.priorRangeFraction,
      stableRangeQuality: rangeAssessment.stableRangeQuality,
      rangeDecisionNote,
      spikeDetected,
      movement,
      window: toWindowSnapshot(windowSpike),
    };
  }

  if (windowSpike.impulseDirection === "up") {
    const cd = contrarianDirectionFromImpulse("up");
    return {
      actionable: true,
      impulseDirection: "up",
      contrarianDirection: cd,
      strength: spikeBandToStrength(windowSpike.band),
      rejections: [],
      stableRangeDetected: rangeAssessment.stableRangeDetected,
      priorRangeFraction: rangeAssessment.priorRangeFraction,
      stableRangeQuality: rangeAssessment.stableRangeQuality,
      rangeDecisionNote,
      spikeDetected,
      movement,
      window: toWindowSnapshot(windowSpike),
    };
  }

  if (windowSpike.impulseDirection === "down") {
    const cd = contrarianDirectionFromImpulse("down");
    return {
      actionable: true,
      impulseDirection: "down",
      contrarianDirection: cd,
      strength: spikeBandToStrength(windowSpike.band),
      rejections: [],
      stableRangeDetected: rangeAssessment.stableRangeDetected,
      priorRangeFraction: rangeAssessment.priorRangeFraction,
      stableRangeQuality: rangeAssessment.stableRangeQuality,
      rangeDecisionNote,
      spikeDetected,
      movement,
      window: toWindowSnapshot(windowSpike),
    };
  }

  return {
    actionable: false,
    impulseDirection: "none",
    contrarianDirection: "none",
    strength: spikeBandToStrength(windowSpike.band),
    rejections: [SIGNAL_GATE_CODES.NO_DIRECTIONAL_MOVE],
    stableRangeDetected: rangeAssessment.stableRangeDetected,
    priorRangeFraction: rangeAssessment.priorRangeFraction,
    stableRangeQuality: rangeAssessment.stableRangeQuality,
    rangeDecisionNote,
    spikeDetected,
    movement,
    window: toWindowSnapshot(windowSpike),
  };
}
