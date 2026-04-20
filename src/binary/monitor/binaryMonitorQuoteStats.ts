/**
 * Session-level YES/NO quote observability + BTC signal vs binary repricing (binary monitor).
 */
const PAIR_DP = 6;

function pairKey(yes: number, no: number): string {
  return `${yes.toFixed(PAIR_DP)}|${no.toFixed(PAIR_DP)}`;
}

function finitePair(
  bo: { yesPrice: number; noPrice: number } | null | undefined
): bo is { yesPrice: number; noPrice: number } {
  if (bo === null || bo === undefined) return false;
  return (
    Number.isFinite(bo.yesPrice) &&
    Number.isFinite(bo.noPrice) &&
    bo.yesPrice > 0 &&
    bo.noPrice > 0
  );
}

export type BinaryQuoteSessionSnapshot = {
  /** Distinct rounded YES|NO pairs seen on ticks with valid quotes. */
  uniqueQuotePairsObserved: number;
  /** Number of tick-to-tick transitions to a different pair (excludes first tick). */
  quoteChangeCount: number;
  /** Ticks where the pair matched the previous tick (excludes first tick). */
  flatQuoteTicks: number;
  /** `flatQuoteTicks / max(1, ticksWithValidQuote - 1)` as percent. */
  flatQuotePercent: number;
  ticksWithValidQuote: number;
  /** Max single-tick percent move on the BTC (signal) mid between consecutive ready ticks. */
  maxBtcSignalTickMovePct: number;
  /** Max per-tick relative range of the rolling buffer: `(max−min)/min` in percent. */
  maxBtcRollingWindowRangePct: number;
  /** Largest tick-to-tick absolute move on YES mid. */
  maxYesTickMoveAbs: number;
  /** Largest tick-to-tick absolute move on NO mid. */
  maxNoTickMoveAbs: number;
};

/** Last ready-tick deltas for compact `[sig×bin]` diagnostics. */
export type BinaryComparativeTickPeek = {
  btcTickMovePct: number;
  yesAbsDelta: number;
  noAbsDelta: number;
};

export class BinaryQuoteSessionStats {
  private readonly seenKeys = new Set<string>();
  private ticksWithValidQuote = 0;
  private quoteChangeCount = 0;
  private flatQuoteTicks = 0;
  private lastKey: string | null = null;
  private lastSignalMid: number | null = null;
  private maxBtcTickMovePct = 0;
  private maxBtcWindowRangePct = 0;
  private lastYesPrice: number | null = null;
  private lastNoPrice: number | null = null;
  private maxYesTickMoveAbs = 0;
  private maxNoTickMoveAbs = 0;
  private lastComparativeTick: BinaryComparativeTickPeek = {
    btcTickMovePct: 0,
    yesAbsDelta: 0,
    noAbsDelta: 0,
  };

  reset(): void {
    this.seenKeys.clear();
    this.ticksWithValidQuote = 0;
    this.quoteChangeCount = 0;
    this.flatQuoteTicks = 0;
    this.lastKey = null;
    this.lastSignalMid = null;
    this.maxBtcTickMovePct = 0;
    this.maxBtcWindowRangePct = 0;
    this.lastYesPrice = null;
    this.lastNoPrice = null;
    this.maxYesTickMoveAbs = 0;
    this.maxNoTickMoveAbs = 0;
    this.lastComparativeTick = { btcTickMovePct: 0, yesAbsDelta: 0, noAbsDelta: 0 };
  }

  /**
   * @param context.signalMid — BTC (underlying) mid for this ready tick.
   * @param context.prices — rolling buffer snapshot (same tick) for window-range max.
   */
  observe(
    outcomes: { yesPrice: number; noPrice: number } | null | undefined,
    context?: { signalMid?: number; prices?: readonly number[] }
  ): void {
    let btcTickMovePct = 0;
    let yesAbsTick = 0;
    let noAbsTick = 0;

    const sm = context?.signalMid;
    if (sm !== undefined && Number.isFinite(sm) && sm > 0) {
      if (this.lastSignalMid !== null && this.lastSignalMid > 0) {
        btcTickMovePct = (Math.abs(sm - this.lastSignalMid) / this.lastSignalMid) * 100;
        this.maxBtcTickMovePct = Math.max(this.maxBtcTickMovePct, btcTickMovePct);
      }
      this.lastSignalMid = sm;
    }

    const px = context?.prices;
    if (px !== undefined && px.length >= 2) {
      const mins = Math.min(...px);
      const maxs = Math.max(...px);
      if (Number.isFinite(mins) && mins > 0 && Number.isFinite(maxs)) {
        const r = ((maxs - mins) / mins) * 100;
        this.maxBtcWindowRangePct = Math.max(this.maxBtcWindowRangePct, r);
      }
    }

    if (!finitePair(outcomes)) {
      this.lastComparativeTick = {
        btcTickMovePct: btcTickMovePct,
        yesAbsDelta: 0,
        noAbsDelta: 0,
      };
      return;
    }

    const { yesPrice, noPrice } = outcomes;
    if (this.lastYesPrice !== null && Number.isFinite(this.lastYesPrice)) {
      yesAbsTick = Math.abs(yesPrice - this.lastYesPrice);
      this.maxYesTickMoveAbs = Math.max(this.maxYesTickMoveAbs, yesAbsTick);
    }
    if (this.lastNoPrice !== null && Number.isFinite(this.lastNoPrice)) {
      noAbsTick = Math.abs(noPrice - this.lastNoPrice);
      this.maxNoTickMoveAbs = Math.max(this.maxNoTickMoveAbs, noAbsTick);
    }
    this.lastYesPrice = yesPrice;
    this.lastNoPrice = noPrice;

    this.lastComparativeTick = {
      btcTickMovePct: btcTickMovePct,
      yesAbsDelta: yesAbsTick,
      noAbsDelta: noAbsTick,
    };

    const k = pairKey(yesPrice, noPrice);
    this.seenKeys.add(k);
    this.ticksWithValidQuote += 1;
    if (this.lastKey !== null) {
      if (k === this.lastKey) this.flatQuoteTicks += 1;
      else this.quoteChangeCount += 1;
    }
    this.lastKey = k;
  }

  /** Latest tick’s comparative deltas (after {@link observe}). */
  peekLastComparativeTick(): BinaryComparativeTickPeek {
    return { ...this.lastComparativeTick };
  }

  snapshot(): BinaryQuoteSessionSnapshot {
    const denom = Math.max(1, this.ticksWithValidQuote - 1);
    return {
      uniqueQuotePairsObserved: this.seenKeys.size,
      quoteChangeCount: this.quoteChangeCount,
      flatQuoteTicks: this.flatQuoteTicks,
      flatQuotePercent: (100 * this.flatQuoteTicks) / denom,
      ticksWithValidQuote: this.ticksWithValidQuote,
      maxBtcSignalTickMovePct: this.maxBtcTickMovePct,
      maxBtcRollingWindowRangePct: this.maxBtcWindowRangePct,
      maxYesTickMoveAbs: this.maxYesTickMoveAbs,
      maxNoTickMoveAbs: this.maxNoTickMoveAbs,
    };
  }
}
