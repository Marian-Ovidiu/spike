import {
  detectContextualSpike,
  detectStableRangePriorToLast,
} from "./strategy.js";

export type EntryDirection = "UP" | "DOWN";

/** Machine codes returned in {@link EntryEvaluation.reasons} when `shouldEnter` is false. */
export const ENTRY_REASON_CODES = {
  MARKET_NOT_STABLE: "market_not_stable",
  SPIKE_NOT_STRONG_ENOUGH: "spike_not_strong_enough",
  OPPOSITE_SIDE_PRICE_TOO_HIGH: "opposite_side_price_too_high",
  INVALID_MARKET_PRICES: "invalid_market_prices",
  NO_SPIKE_DIRECTION: "no_spike_direction",
} as const;

export type EntryEvaluation = {
  shouldEnter: boolean;
  direction: EntryDirection | null;
  /** Non-empty when `shouldEnter` is false; empty when entry is allowed. */
  reasons: string[];
};

export type EvaluateEntryConditionsInput = {
  prices: readonly number[];
  rangeThreshold: number;
  previousPrice: number;
  currentPrice: number;
  spikeThreshold: number;
  /**
   * Spike move must be ≥ this multiple of prior-window relative range (chop).
   * Higher = fewer marginal signals.
   */
  spikeMinRangeMultiple: number;
  entryPrice: number;
  /** Quote for the “UP” / YES-style leg (used when the spike is down → enter opposite UP). */
  upSidePrice: number;
  /** Quote for the “DOWN” / NO-style leg (used when the spike is up → enter opposite DOWN). */
  downSidePrice: number;
};

/** Short human-readable lines for console / logs (codes → English). */
export const ENTRY_REASON_MESSAGES: Record<string, string> = {
  [ENTRY_REASON_CODES.MARKET_NOT_STABLE]:
    "prior window not stable enough (range too wide vs threshold)",
  [ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH]:
    "spike not strong enough vs threshold and prior chop",
  [ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH]:
    "opposite-side quote not below entry price",
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
 * `direction` is the side you would enter (opposite to the spike move).
 */
export function evaluateEntryConditions(
  input: EvaluateEntryConditionsInput
): EntryEvaluation {
  const {
    prices,
    rangeThreshold,
    previousPrice,
    currentPrice,
    spikeThreshold,
    spikeMinRangeMultiple,
    entryPrice,
    upSidePrice,
    downSidePrice,
  } = input;

  if (!Number.isFinite(upSidePrice) || !Number.isFinite(downSidePrice)) {
    return {
      shouldEnter: false,
      direction: null,
      reasons: [ENTRY_REASON_CODES.INVALID_MARKET_PRICES],
    };
  }

  const marketStable = detectStableRangePriorToLast(prices, rangeThreshold);
  const priorWindow = prices.slice(0, -1);
  const spikeDetected = detectContextualSpike(
    previousPrice,
    currentPrice,
    spikeThreshold,
    priorWindow,
    spikeMinRangeMultiple
  );

  const gateReasons: string[] = [];
  if (!marketStable) {
    gateReasons.push(ENTRY_REASON_CODES.MARKET_NOT_STABLE);
  }
  if (!spikeDetected) {
    gateReasons.push(ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH);
  }
  if (gateReasons.length > 0) {
    return {
      shouldEnter: false,
      direction: null,
      reasons: gateReasons,
    };
  }

  if (currentPrice > previousPrice) {
    const priceOk = downSidePrice < entryPrice;
    return {
      shouldEnter: priceOk,
      direction: "DOWN",
      reasons: priceOk
        ? []
        : [ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH],
    };
  }

  if (currentPrice < previousPrice) {
    const priceOk = upSidePrice < entryPrice;
    return {
      shouldEnter: priceOk,
      direction: "UP",
      reasons: priceOk
        ? []
        : [ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH],
    };
  }

  return {
    shouldEnter: false,
    direction: null,
    reasons: [ENTRY_REASON_CODES.NO_SPIKE_DIRECTION],
  };
}
