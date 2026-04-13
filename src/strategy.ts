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
