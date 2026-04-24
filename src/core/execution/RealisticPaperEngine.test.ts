import { describe, expect, it } from "vitest";
import { RealisticPaperEngine } from "./RealisticPaperEngine.js";
import type { FuturesPaperEngineConfig } from "./futuresPaperTypes.js";
import type { TopOfBookL1 } from "../domain/book.js";

function book(mid: number, spreadBps: number): TopOfBookL1 {
  const half = (spreadBps / 10_000 / 2) * mid;
  const bid = mid - half;
  const ask = mid + half;
  return {
    bestBid: bid,
    bestAsk: ask,
    midPrice: mid,
    spreadBps: ((ask - bid) / mid) * 10_000,
  };
}

const contract = {
  tickSize: 0.1,
  lotSize: 0.5,
  minQuantity: 0.5,
  contractMultiplier: 1,
};

const baseConfig = (overrides: Partial<FuturesPaperEngineConfig & {
  realisticMode: boolean;
  makerFeeBps: number;
  takerFeeBps: number;
  realisticSlippageBps: number;
  realisticLatencyMs: number;
  realisticSpreadBps: number;
  partialFillEnabled: boolean;
  partialFillRatio: number;
  fundingBpsPerHour: number;
  minNotionalQuote: number;
}> = {}) => ({
  takeProfitBps: 10_000,
  stopLossBps: 10_000,
  exitTimeoutMs: 0,
  feeRoundTripBps: 0,
  slippageBps: 0,
  exitGracePeriodMs: 0,
  forcedExitPenaltyBps: 25,
  realisticMode: true,
  makerFeeBps: 0,
  takerFeeBps: 10,
  realisticSlippageBps: 2,
  realisticLatencyMs: 100,
  realisticSpreadBps: 20,
  partialFillEnabled: false,
  partialFillRatio: 1,
  fundingBpsPerHour: 12,
  minNotionalQuote: 0,
  ...overrides,
});

describe("RealisticPaperEngine", () => {
  it("normalizes quantity and price, then reports a realistic cost breakdown", () => {
    const eng = new RealisticPaperEngine(baseConfig());
    const openBook = book(100, 10);
    const open = eng.openLong({
      instrumentId: "test:btc",
      quantity: 1.23,
      book: openBook,
      nowMs: 0,
      contract,
    });
    expect(open.ok).toBe(true);
    if (!open.ok) throw new Error("open");
    expect(open.avgEntryPrice).toBeCloseTo(
      Math.round(open.avgEntryPrice / contract.tickSize) * contract.tickSize,
      10
    );
    expect(open.feesOpenQuote).toBeGreaterThan(0);

    const position = eng.getOpenPosition();
    expect(position?.quantity).toBeCloseTo(1);

    const closeBook = book(102, 10);
    const closed = eng.closeManual(closeBook, 3_600_000);
    expect(closed).not.toBeNull();
    if (!closed) throw new Error("close");
    expect(closed.spreadCost).toBeDefined();
    expect(closed.slippageCost).toBeDefined();
    expect(closed.latencyCost).toBeDefined();
    expect(closed.fundingCost).toBeDefined();
    expect(closed.edgeBeforeCosts).toBeDefined();
    expect(closed.edgeAfterCosts).toBeDefined();
    expect(closed.netPnl).toBeCloseTo(closed.netPnlQuote);
  });

  it("supports partial fill and rejects below-min-notional orders", () => {
    const partial = new RealisticPaperEngine(
      baseConfig({ partialFillEnabled: true, partialFillRatio: 0.5, takerFeeBps: 0 })
    );
    const open = partial.openLong({
      instrumentId: "test:btc",
      quantity: 2.2,
      book: book(100, 10),
      nowMs: 0,
      contract,
    });
    expect(open.ok).toBe(true);
    if (!open.ok) throw new Error("open");
    expect(partial.getOpenPosition()?.quantity).toBeCloseTo(1);

    const minNotional = new RealisticPaperEngine(
      baseConfig({ minNotionalQuote: 250, takerFeeBps: 0 })
    );
    const rejected = minNotional.openLong({
      instrumentId: "test:btc",
      quantity: 1,
      book: book(100, 10),
      nowMs: 0,
      contract,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("unexpected");
    expect(rejected.reason).toBe("below_min_notional");
  });
});
