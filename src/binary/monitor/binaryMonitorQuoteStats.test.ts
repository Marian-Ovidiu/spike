import { describe, expect, it } from "vitest";
import { BinaryQuoteSessionStats } from "./binaryMonitorQuoteStats.js";

describe("BinaryQuoteSessionStats", () => {
  it("counts unique pairs, changes, and flat percentage", () => {
    const s = new BinaryQuoteSessionStats();
    s.observe({ yesPrice: 0.5, noPrice: 0.5 });
    s.observe({ yesPrice: 0.5, noPrice: 0.5 });
    s.observe({ yesPrice: 0.51, noPrice: 0.49 });
    s.observe({ yesPrice: 0.51, noPrice: 0.49 });
    const snap = s.snapshot();
    expect(snap.uniqueQuotePairsObserved).toBe(2);
    expect(snap.quoteChangeCount).toBe(1);
    expect(snap.flatQuoteTicks).toBe(2);
    expect(snap.ticksWithValidQuote).toBe(4);
    expect(snap.flatQuotePercent).toBeCloseTo((2 / 3) * 100, 5);
    expect(snap.maxBtcSignalTickMovePct).toBe(0);
    expect(snap.maxBtcRollingWindowRangePct).toBe(0);
    expect(snap.maxYesTickMoveAbs).toBeCloseTo(0.01, 8);
    expect(snap.maxNoTickMoveAbs).toBeCloseTo(0.01, 8);
  });

  it("tracks BTC signal tick move and rolling-window range", () => {
    const s = new BinaryQuoteSessionStats();
    s.observe(
      { yesPrice: 0.5, noPrice: 0.5 },
      { signalMid: 100_000, prices: [99_900, 100_000, 100_050] }
    );
    s.observe(
      { yesPrice: 0.5, noPrice: 0.5 },
      { signalMid: 101_000, prices: [100_000, 100_500, 101_000] }
    );
    const snap = s.snapshot();
    expect(snap.maxBtcSignalTickMovePct).toBeCloseTo(1, 3);
    const winR = ((100_050 - 99_900) / 99_900) * 100;
    const winR2 = ((101_000 - 100_000) / 100_000) * 100;
    expect(snap.maxBtcRollingWindowRangePct).toBeCloseTo(Math.max(winR, winR2), 5);
  });
});
