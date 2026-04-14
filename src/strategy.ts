/**
 * True when recent prices sit in a tight band: relative span below `rangeThreshold`.
 * Uses (max − min) / min strictly less than `rangeThreshold` (requires positive min).
 */
export function detectStableRange(
  prices: readonly number[],
  rangeThreshold: number
): boolean {
  if (prices.length === 0) return false;

  const max = Math.max(...prices);
  const min = Math.min(...prices);

  if (!(min > 0 && Number.isFinite(min) && Number.isFinite(max))) {
    return false;
  }

  return (max - min) / min < rangeThreshold;
}

/** Delegates to {@link detectStableRange}. */
export function isRangeStable(
  prices: readonly number[],
  threshold: number
): boolean {
  return detectStableRange(prices, threshold);
}

/**
 * Stability of the regime **before** the latest tick (excludes last price).
 * Avoids treating the spike candle as part of the “calm” range.
 */
export function detectStableRangePriorToLast(
  prices: readonly number[],
  rangeThreshold: number
): boolean {
  if (prices.length < 2) return false;
  return detectStableRange(prices.slice(0, -1), rangeThreshold);
}

/**
 * Spike when the absolute relative move exceeds `spikeThreshold`.
 * Relative change is |current − previous| / previous (handles both up and down).
 * Threshold matches config scale (e.g. 0.004 means 0.4% move).
 */
export function detectSpike(
  previousPrice: number,
  currentPrice: number,
  spikeThreshold: number
): boolean {
  if (
    !(previousPrice > 0) ||
    !Number.isFinite(previousPrice) ||
    !Number.isFinite(currentPrice)
  ) {
    return false;
  }

  const relativeChange = Math.abs(currentPrice - previousPrice) / previousPrice;
  return relativeChange > spikeThreshold;
}

/**
 * High-quality spike: passes {@link detectSpike} and the move is large vs prior-window chop
 * (reduces false positives when a tick barely clears the spike threshold during noisy chop).
 */
export function detectContextualSpike(
  previousPrice: number,
  currentPrice: number,
  spikeThreshold: number,
  priorWindowPrices: readonly number[],
  minSpikeVsRangeMultiple: number
): boolean {
  if (!detectSpike(previousPrice, currentPrice, spikeThreshold)) {
    return false;
  }

  if (
    priorWindowPrices.length < 2 ||
    !Number.isFinite(minSpikeVsRangeMultiple) ||
    minSpikeVsRangeMultiple <= 0
  ) {
    return true;
  }

  const max = Math.max(...priorWindowPrices);
  const min = Math.min(...priorWindowPrices);
  if (!(min > 0 && Number.isFinite(min) && Number.isFinite(max))) {
    return false;
  }

  const rangeSpan = (max - min) / min;
  const tickMove =
    Math.abs(currentPrice - previousPrice) / previousPrice;

  if (rangeSpan <= 0) {
    return tickMove > spikeThreshold;
  }

  return tickMove >= rangeSpan * minSpikeVsRangeMultiple;
}

/** Delegates to {@link detectSpike}. */
export function isSpike(
  prev: number,
  current: number,
  threshold: number
): boolean {
  return detectSpike(prev, current, threshold);
}

/* ─── Window-based spike detection ───────────────────────────────── */

export type WindowSpikeSource =
  | "tick-1"
  | "tick-2"
  | "tick-3"
  | "window-oldest";

export type MovementClassification =
  | "no_signal"
  | "borderline"
  | "strong_spike";

export type WindowSpikeComparison = {
  source: WindowSpikeSource;
  referencePrice: number;
  relativeMove: number;
  absoluteDelta: number;
  exceeds: boolean;
};

export type WindowSpikeResult = {
  /** New first-level movement quality classification. */
  classification: MovementClassification;
  /** Strongest relative move (fraction, e.g. 0.0012 = 0.12%). */
  strongestMovePercent: number;
  strongestMoveAbsolute: number;
  strongestMoveDirection: "UP" | "DOWN" | null;
  thresholdPercent: number;
  thresholdRatio: number;
  sourceWindowLabel: string | null;
  borderlineMinRatio: number;

  /* Backward-compatible aliases / legacy fields. */
  detected: boolean;
  currentPrice: number;
  /** Largest fractional relative move across all comparisons. */
  strongestMove: number;
  strongestAbsDelta: number;
  referencePrice: number;
  source: WindowSpikeSource;
  direction: "up" | "down" | null;
  comparisons: WindowSpikeComparison[];
};

const EMPTY_WINDOW_SPIKE: WindowSpikeResult = {
  classification: "no_signal",
  strongestMovePercent: 0,
  strongestMoveAbsolute: 0,
  strongestMoveDirection: null,
  thresholdPercent: 0,
  thresholdRatio: 0,
  sourceWindowLabel: null,
  borderlineMinRatio: 0.85,
  detected: false,
  currentPrice: 0,
  strongestMove: 0,
  strongestAbsDelta: 0,
  referencePrice: 0,
  source: "tick-1",
  direction: null,
  comparisons: [],
};

/**
 * Compare the current price (last element of `prices`) against several
 * look-back points: tick-1, tick-2, tick-3, and the oldest price in the
 * last `windowTicks` ticks. Returns first-level movement classification:
 * - `strong_spike`: strongest move >= threshold
 * - `borderline`: strongest move >= threshold * borderlineMinRatio and < threshold
 * - `no_signal`: strongest move below threshold * borderlineMinRatio
 *
 * @param windowTicks  Number of ticks to look back for the "window-oldest"
 *   comparison (default 2 ≈ 10 s at 5 s/tick).
 * @param borderlineMinRatio  Lower ratio for borderline bucket (default 0.85).
 */
export function detectWindowSpike(
  prices: readonly number[],
  spikeThreshold: number,
  windowTicks = 2,
  borderlineMinRatio = 0.85,
): WindowSpikeResult {
  const n = prices.length;
  const saneBorderline = Math.min(
    1,
    Math.max(0, Number.isFinite(borderlineMinRatio) ? borderlineMinRatio : 0.85),
  );
  if (n < 2) {
    return {
      ...EMPTY_WINDOW_SPIKE,
      thresholdPercent: spikeThreshold,
      borderlineMinRatio: saneBorderline,
    };
  }

  const current = prices[n - 1]!;

  const candidates: Array<{ source: WindowSpikeSource; index: number }> = [];
  candidates.push({ source: "tick-1", index: n - 2 });
  if (n >= 3) candidates.push({ source: "tick-2", index: n - 3 });
  if (n >= 4) candidates.push({ source: "tick-3", index: n - 4 });

  const windowOldestIdx = n - 1 - windowTicks;
  if (windowOldestIdx >= 0) {
    const alreadyCovered = candidates.some((c) => c.index === windowOldestIdx);
    if (!alreadyCovered) {
      candidates.push({ source: "window-oldest", index: windowOldestIdx });
    }
  }

  const comparisons: WindowSpikeComparison[] = [];
  let best: {
    move: number;
    absDelta: number;
    ref: number;
    source: WindowSpikeSource;
  } | null = null;

  for (const { source, index } of candidates) {
    const ref = prices[index]!;
    if (!(ref > 0) || !Number.isFinite(ref) || !Number.isFinite(current)) {
      comparisons.push({
        source,
        referencePrice: ref,
        relativeMove: 0,
        absoluteDelta: 0,
        exceeds: false,
      });
      continue;
    }
    const absDelta = Math.abs(current - ref);
    const relMove = absDelta / ref;
    comparisons.push({
      source,
      referencePrice: ref,
      relativeMove: relMove,
      absoluteDelta: absDelta,
      exceeds: relMove > spikeThreshold,
    });
    if (best === null || relMove > best.move) {
      best = { move: relMove, absDelta, ref, source };
    }
  }

  if (!best) {
    return {
      ...EMPTY_WINDOW_SPIKE,
      currentPrice: current,
      comparisons,
      thresholdPercent: spikeThreshold,
      borderlineMinRatio: saneBorderline,
    };
  }

  const thresholdRatio =
    spikeThreshold > 0 ? best.move / spikeThreshold : 0;
  const borderlineFloor = spikeThreshold * saneBorderline;
  const classification: MovementClassification =
    best.move >= spikeThreshold
      ? "strong_spike"
      : best.move >= borderlineFloor
        ? "borderline"
        : "no_signal";

  const strongestMoveDirection: "UP" | "DOWN" | null =
    current > best.ref ? "UP" : current < best.ref ? "DOWN" : null;

  return {
    classification,
    strongestMovePercent: best.move,
    strongestMoveAbsolute: best.absDelta,
    strongestMoveDirection,
    thresholdPercent: spikeThreshold,
    thresholdRatio,
    sourceWindowLabel: best.source,
    borderlineMinRatio: saneBorderline,

    detected: classification === "strong_spike",
    currentPrice: current,
    strongestMove: best.move,
    strongestAbsDelta: best.absDelta,
    referencePrice: best.ref,
    source: best.source,
    direction: strongestMoveDirection === "UP"
      ? "up"
      : strongestMoveDirection === "DOWN"
        ? "down"
        : null,
    comparisons,
  };
}

/**
 * True when `relativeMove` is contextually strong — i.e. large compared
 * to the chop (max−min)/min of `priorWindowPrices`.
 * Extracted from {@link detectContextualSpike} so it can be applied to
 * any move magnitude (including window-spike strongest move).
 */
export function isMoveDominantVsChop(
  relativeMove: number,
  priorWindowPrices: readonly number[],
  minMultiple: number,
  spikeThreshold: number,
): boolean {
  if (
    priorWindowPrices.length < 2 ||
    !Number.isFinite(minMultiple) ||
    minMultiple <= 0
  ) {
    return relativeMove > spikeThreshold;
  }
  const max = Math.max(...priorWindowPrices);
  const min = Math.min(...priorWindowPrices);
  if (!(min > 0 && Number.isFinite(min) && Number.isFinite(max))) {
    return false;
  }
  const rangeSpan = (max - min) / min;
  if (rangeSpan <= 0) {
    return relativeMove > spikeThreshold;
  }
  return relativeMove >= rangeSpan * minMultiple;
}
