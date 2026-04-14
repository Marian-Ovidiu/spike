import {
  isMoveDominantVsChop,
  type WindowSpikeResult,
} from "./strategy.js";
import { classifyMovementWindow } from "./movementClassifier.js";
import {
  assessStableRangeQuality,
  type StableRangeQuality,
} from "./rangeQualityEvaluator.js";
import {
  isStrongSpikeClassification,
  toMovementAnalysis,
  type MovementAnalysis,
} from "./movementAnalysis.js";
import { evaluateQuoteQuality } from "./quoteQualityFilter.js";

export type EntryDirection = "UP" | "DOWN";

/** Machine codes returned in {@link EntryEvaluation.reasons} when `shouldEnter` is false. */
export const ENTRY_REASON_CODES = {
  MARKET_NOT_STABLE: "market_not_stable",
  RANGE_TOO_NOISY: "range_too_noisy_for_entry",
  SPIKE_NOT_STRONG_ENOUGH: "spike_not_strong_enough",
  OPPOSITE_SIDE_PRICE_TOO_HIGH: "opposite_side_price_too_high",
  MARKET_QUOTES_TOO_NEUTRAL: "market_quotes_too_neutral",
  INVALID_MARKET_PRICES: "invalid_market_prices",
  NO_SPIKE_DIRECTION: "no_spike_direction",
} as const;

export type EntryEvaluation = {
  shouldEnter: boolean;
  direction: EntryDirection | null;
  /** Non-empty when `shouldEnter` is false; empty when entry is allowed. */
  reasons: string[];
  stableRangeDetected: boolean;
  priorRangePercent: number;
  stableRangeQuality: StableRangeQuality;
  rangeDecisionNote: string;
  movementClassification: "no_signal" | "borderline" | "strong_spike";
  spikeDetected: boolean;
  movement: MovementAnalysis;
  /** Window-based spike analysis for the current tick. */
  windowSpike: WindowSpikeResult | undefined;
};

export type EvaluateEntryConditionsInput = {
  prices: readonly number[];
  rangeThreshold: number;
  stableRangeSoftToleranceRatio: number;
  strongSpikeHardRejectPoorRange: boolean;
  previousPrice: number;
  currentPrice: number;
  spikeThreshold: number;
  /**
   * Spike move must be ≥ this multiple of prior-window relative range (chop).
   * Higher = fewer marginal signals.
   */
  spikeMinRangeMultiple: number;
  /** Borderline lower bound as ratio of `spikeThreshold` (e.g. 0.85). */
  borderlineMinRatio: number;
  entryPrice: number;
  maxOppositeSideEntryPrice: number;
  neutralQuoteBandMin: number;
  neutralQuoteBandMax: number;
  /** Quote for the "UP" / YES-style leg (used when the spike is down → enter opposite UP). */
  upSidePrice: number;
  /** Quote for the "DOWN" / NO-style leg (used when the spike is up → enter opposite DOWN). */
  downSidePrice: number;
};

/** Short human-readable lines for console / logs (codes → English). */
export const ENTRY_REASON_MESSAGES: Record<string, string> = {
  [ENTRY_REASON_CODES.MARKET_NOT_STABLE]:
    "prior window not stable enough (range too wide vs threshold)",
  [ENTRY_REASON_CODES.RANGE_TOO_NOISY]:
    "range too noisy for entry",
  [ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH]:
    "movement below required strength for immediate strong-spike entry",
  [ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH]:
    "opposite-side quote above allowed cap",
  [ENTRY_REASON_CODES.MARKET_QUOTES_TOO_NEUTRAL]:
    "YES/NO quotes too neutral for contrarian edge",
  [ENTRY_REASON_CODES.INVALID_MARKET_PRICES]:
    "YES/NO quotes missing or non-finite",
  [ENTRY_REASON_CODES.NO_SPIKE_DIRECTION]:
    "no one-tick direction (flat candle)",
};

/** Maps rejection codes to readable text for logging. */
export function formatEntryReasonsForLog(entry: EntryEvaluation): string {
  if (entry.shouldEnter || entry.reasons.length === 0) {
    return "";
  }
  return entry.reasons
    .map((c) => ENTRY_REASON_MESSAGES[c] ?? c)
    .join("; ");
}

/**
 * Mean-reversion entry: stable range + spike + cheap enough opposite outcome.
 *
 * Spike detection uses a **short rolling window** (tick-1, tick-2, tick-3,
 * and oldest in the last N-second window).  A spike is detected when *any*
 * comparison exceeds `spikeThreshold`, and the strongest move must also
 * dominate prior-window chop (contextual filter).
 *
 * `direction` is the side you would enter (opposite to the spike move).
 */
export function evaluateEntryConditions(
  input: EvaluateEntryConditionsInput
): EntryEvaluation {
  const {
    prices,
    rangeThreshold,
    stableRangeSoftToleranceRatio,
    strongSpikeHardRejectPoorRange,
    spikeThreshold,
    spikeMinRangeMultiple,
    borderlineMinRatio,
    entryPrice,
    maxOppositeSideEntryPrice,
    neutralQuoteBandMin,
    neutralQuoteBandMax,
    upSidePrice,
    downSidePrice,
  } = input;

  if (!Number.isFinite(upSidePrice) || !Number.isFinite(downSidePrice)) {
    return {
      shouldEnter: false,
      direction: null,
      reasons: [ENTRY_REASON_CODES.INVALID_MARKET_PRICES],
      stableRangeDetected: false,
      priorRangePercent: 0,
      stableRangeQuality: "poor",
      rangeDecisionNote: "invalid market prices",
      movementClassification: "no_signal",
      spikeDetected: false,
      movement: {
        strongestMovePercent: 0,
        strongestMoveAbsolute: 0,
        strongestMoveDirection: null,
        thresholdPercent: spikeThreshold,
        thresholdRatio: 0,
        classification: "no_signal",
        sourceWindowLabel: null,
      },
      windowSpike: undefined,
    };
  }

  const rangeAssessment = assessStableRangeQuality({
    prices,
    rangeThreshold,
    stableRangeSoftToleranceRatio,
  });

  const windowSpike = classifyMovementWindow({
    prices,
    spikeThreshold,
    borderlineMinRatio,
    windowTicks: 2,
  });

  const priorWindow = prices.slice(0, -1);
  const movement: MovementAnalysis = toMovementAnalysis(windowSpike);
  const contextuallyStrong =
    isStrongSpikeClassification(windowSpike.classification) &&
    isMoveDominantVsChop(
      windowSpike.strongestMove,
      priorWindow,
      spikeMinRangeMultiple,
      spikeThreshold,
    );
  const spikeDetected = isStrongSpikeClassification(windowSpike.classification);
  if (spikeDetected && !windowSpike.detected) {
    throw new Error("Invariant: strong_spike classification must set detected=true");
  }

  const gateReasons: string[] = [];
  const veryStrongOverride = spikeDetected && windowSpike.thresholdRatio >= 1.8;
  if (spikeDetected) {
    if (strongSpikeHardRejectPoorRange && rangeAssessment.stableRangeQuality === "poor") {
      gateReasons.push(ENTRY_REASON_CODES.RANGE_TOO_NOISY);
    }
  } else {
    if (!contextuallyStrong) {
      gateReasons.push(ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH);
    }
    if (rangeAssessment.stableRangeQuality === "poor" && !veryStrongOverride) {
      gateReasons.push(ENTRY_REASON_CODES.RANGE_TOO_NOISY);
    } else if (
      !rangeAssessment.stableRangeDetected &&
      rangeAssessment.stableRangeQuality === "acceptable"
    ) {
      gateReasons.push(ENTRY_REASON_CODES.MARKET_NOT_STABLE);
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
      shouldEnter: false,
      direction: null,
      reasons: gateReasons,
      stableRangeDetected: rangeAssessment.stableRangeDetected,
      priorRangePercent: rangeAssessment.priorRangePercent,
      stableRangeQuality: rangeAssessment.stableRangeQuality,
      rangeDecisionNote,
      movementClassification: windowSpike.classification,
      spikeDetected,
      movement,
      windowSpike,
    };
  }

  if (windowSpike.strongestMoveDirection === "UP") {
    const quoteBlocker = evaluateQuoteQuality({
      upSidePrice,
      downSidePrice,
      direction: "DOWN",
      entryPrice,
      maxOppositeSideEntryPrice,
      neutralQuoteBandMin,
      neutralQuoteBandMax,
    });
    const priceOk = quoteBlocker === null;
    return {
      shouldEnter: priceOk,
      direction: "DOWN",
      reasons: priceOk
        ? []
        : [
            quoteBlocker === "market_quotes_too_neutral"
              ? ENTRY_REASON_CODES.MARKET_QUOTES_TOO_NEUTRAL
              : ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH,
          ],
      stableRangeDetected: rangeAssessment.stableRangeDetected,
      priorRangePercent: rangeAssessment.priorRangePercent,
      stableRangeQuality: rangeAssessment.stableRangeQuality,
      rangeDecisionNote,
      movementClassification: windowSpike.classification,
      spikeDetected,
      movement,
      windowSpike,
    };
  }

  if (windowSpike.strongestMoveDirection === "DOWN") {
    const quoteBlocker = evaluateQuoteQuality({
      upSidePrice,
      downSidePrice,
      direction: "UP",
      entryPrice,
      maxOppositeSideEntryPrice,
      neutralQuoteBandMin,
      neutralQuoteBandMax,
    });
    const priceOk = quoteBlocker === null;
    return {
      shouldEnter: priceOk,
      direction: "UP",
      reasons: priceOk
        ? []
        : [
            quoteBlocker === "market_quotes_too_neutral"
              ? ENTRY_REASON_CODES.MARKET_QUOTES_TOO_NEUTRAL
              : ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH,
          ],
      stableRangeDetected: rangeAssessment.stableRangeDetected,
      priorRangePercent: rangeAssessment.priorRangePercent,
      stableRangeQuality: rangeAssessment.stableRangeQuality,
      rangeDecisionNote,
      movementClassification: windowSpike.classification,
      spikeDetected,
      movement,
      windowSpike,
    };
  }

  return {
    shouldEnter: false,
    direction: null,
    reasons: [ENTRY_REASON_CODES.NO_SPIKE_DIRECTION],
    stableRangeDetected: rangeAssessment.stableRangeDetected,
    priorRangePercent: rangeAssessment.priorRangePercent,
    stableRangeQuality: rangeAssessment.stableRangeQuality,
    rangeDecisionNote,
    movementClassification: windowSpike.classification,
    spikeDetected,
    movement,
    windowSpike,
  };
}
