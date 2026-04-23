/**
 * Neutral signal domain types (no venue, no outcome prices, no execution quotes).
 */

/** Direction of an impulse move in the signal window. */
export type SignalDirection = "up" | "down" | "none";

/**
 * Discrete strength tier for the current window (mapped from internal spike band).
 */
export type SignalStrength = "none" | "borderline" | "strong";

/** Rejection at the signal layer only (range/spike/tradability — not liquidity). */
export type SignalRejectionReason =
  | "prior_window_not_stable"
  | "range_too_noisy"
  | "spike_below_threshold"
  | "no_directional_move"
  | "borderline_below_tradability"
  | "chop_dominant";

/** Quality of the pre-move range (same semantics as legacy stable-range quality). */
export type StableRangeQuality = "good" | "acceptable" | "poor";

export type StableRangeAssessment = {
  stableRangeDetected: boolean;
  priorRangeFraction: number;
  stableRangeQuality: StableRangeQuality;
};

export type SignalMovementSummary = {
  /** Largest relative move in the window (fraction, e.g. 0.012 = 1.2%). */
  strongestMoveFraction: number;
  strongestMoveAbsolute: number;
  impulseDirection: SignalDirection;
  thresholdFraction: number;
  thresholdRatio: number;
  strength: SignalStrength;
  referenceWindowLabel: string | null;
};

/** Full snapshot of window spike math (neutral naming; legacy-compatible fields omitted). */
export type SignalWindowSnapshot = {
  strength: SignalStrength;
  strongestMoveFraction: number;
  strongestMoveAbsolute: number;
  impulseDirection: SignalDirection;
  thresholdFraction: number;
  thresholdRatio: number;
  referenceWindowLabel: string | null;
  borderlineMinRatio: number;
  detectedStrongWindow: boolean;
  currentSample: number;
  referencePrice: number;
  comparisons: readonly SignalWindowComparison[];
};

export type SignalWindowComparison = {
  referenceKind: string;
  referencePrice: number;
  relativeMove: number;
  absoluteDelta: number;
  exceedsThreshold: boolean;
};

/**
 * Result of evaluating only the signal path (rolling prices + range + spike context).
 * No bid/ask, spread, or binary-specific concepts.
 */
export type SignalEvaluation = {
  /** True when mean-reversion signal gates pass (still no execution/L2 guarantees). */
  actionable: boolean;
  impulseDirection: SignalDirection;
  /** Classical MR bias: fade the impulse (none if flat / blocked). */
  contrarianDirection: SignalDirection;
  strength: SignalStrength;
  rejections: SignalRejectionReason[];
  stableRangeDetected: boolean;
  priorRangeFraction: number;
  stableRangeQuality: StableRangeQuality;
  rangeDecisionNote: string;
  spikeDetected: boolean;
  movement: SignalMovementSummary;
  window: SignalWindowSnapshot;
};
