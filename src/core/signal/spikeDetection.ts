import type { SignalDirection } from "./types.js";

/**
 * Relative span stability: (max−min)/min strictly below `rangeThreshold`
 * (requires strictly positive min).
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

export function detectStableRangePriorToLast(
  prices: readonly number[],
  rangeThreshold: number
): boolean {
  if (prices.length < 2) return false;
  return detectStableRange(prices.slice(0, -1), rangeThreshold);
}

/**
 * Spike when |current − previous| / previous exceeds `spikeThreshold` (fraction).
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

export type SpikeReferenceKind =
  | "tick-1"
  | "tick-2"
  | "tick-3"
  | "window-oldest";

/** Internal band labels (mapped to {@link SignalStrength} at the API boundary). */
export type SpikeBand = "no_signal" | "borderline" | "strong_spike";

export type SpikeWindowComparison = {
  source: SpikeReferenceKind;
  referencePrice: number;
  relativeMove: number;
  absoluteDelta: number;
  exceeds: boolean;
};

export type SpikeWindowResult = {
  band: SpikeBand;
  strongestMoveFraction: number;
  strongestMoveAbsolute: number;
  impulseDirection: SignalDirection;
  thresholdFraction: number;
  thresholdRatio: number;
  sourceWindowLabel: SpikeReferenceKind | null;
  borderlineMinRatio: number;

  detectedStrongWindow: boolean;
  currentSample: number;
  strongestMove: number;
  strongestAbsDelta: number;
  referencePrice: number;
  source: SpikeReferenceKind;
  comparisons: SpikeWindowComparison[];
};

const EMPTY: SpikeWindowResult = {
  band: "no_signal",
  strongestMoveFraction: 0,
  strongestMoveAbsolute: 0,
  impulseDirection: "none",
  thresholdFraction: 0,
  thresholdRatio: 0,
  sourceWindowLabel: null,
  borderlineMinRatio: 0.85,
  detectedStrongWindow: false,
  currentSample: 0,
  strongestMove: 0,
  strongestAbsDelta: 0,
  referencePrice: 0,
  source: "tick-1",
  comparisons: [],
};

/**
 * Window spike: compare last sample to tick-1, tick-2, tick-3, and window-oldest.
 */
export function detectWindowSpike(
  prices: readonly number[],
  spikeThreshold: number,
  windowTicks = 2,
  borderlineMinRatio = 0.85
): SpikeWindowResult {
  const n = prices.length;
  const saneBorderline = Math.min(
    1,
    Math.max(0, Number.isFinite(borderlineMinRatio) ? borderlineMinRatio : 0.85)
  );
  if (n < 2) {
    return {
      ...EMPTY,
      thresholdFraction: spikeThreshold,
      borderlineMinRatio: saneBorderline,
    };
  }

  const current = prices[n - 1]!;

  const candidates: Array<{ source: SpikeReferenceKind; index: number }> = [];
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

  const comparisons: SpikeWindowComparison[] = [];
  let best: {
    move: number;
    absDelta: number;
    ref: number;
    source: SpikeReferenceKind;
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
      ...EMPTY,
      currentSample: current,
      comparisons,
      thresholdFraction: spikeThreshold,
      borderlineMinRatio: saneBorderline,
    };
  }

  const thresholdRatio =
    spikeThreshold > 0 ? best.move / spikeThreshold : 0;
  const borderlineFloor = spikeThreshold * saneBorderline;
  const band: SpikeBand =
    best.move >= spikeThreshold
      ? "strong_spike"
      : best.move >= borderlineFloor
        ? "borderline"
        : "no_signal";

  const impulseDirection: SignalDirection =
    current > best.ref ? "up" : current < best.ref ? "down" : "none";

  return {
    band,
    strongestMoveFraction: best.move,
    strongestMoveAbsolute: best.absDelta,
    impulseDirection,
    thresholdFraction: spikeThreshold,
    thresholdRatio,
    sourceWindowLabel: best.source,
    borderlineMinRatio: saneBorderline,

    detectedStrongWindow: band === "strong_spike",
    currentSample: current,
    strongestMove: best.move,
    strongestAbsDelta: best.absDelta,
    referencePrice: best.ref,
    source: best.source,
    comparisons,
  };
}

export function isMoveDominantVsChop(
  relativeMove: number,
  priorWindowPrices: readonly number[],
  minMultiple: number,
  spikeThreshold: number
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
