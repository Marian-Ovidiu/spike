import { describe, expect, it } from "vitest";

import { SyntheticBinaryMarket } from "./syntheticBinaryMarket.js";

describe("SyntheticBinaryMarket", () => {
  it("clamps setSpreadBps between base and max", () => {
    const m = new SyntheticBinaryMarket({
      spreadBps: 20,
      maxSpreadBps: 50,
      slippageBps: 0,
      maxLiquidityPerTrade: 0,
    });
    expect(m.getBaseSpreadBps()).toBe(20);
    m.setSpreadBps(5);
    expect(m.getSpreadBps()).toBe(20);
    m.setSpreadBps(200);
    expect(m.getSpreadBps()).toBe(50);
  });

  it("derives NO mid from probability and builds bid/ask", () => {
    const m = new SyntheticBinaryMarket({ spreadBps: 40, slippageBps: 0, maxLiquidityPerTrade: 0 });
    m.setProbabilityUp(0.6);
    const q = m.getQuoteSnapshot();
    expect(q.yesMid).toBeCloseTo(0.6, 6);
    expect(q.noMid).toBeCloseTo(0.4, 6);
    expect(q.yesAsk).toBeGreaterThan(q.yesBid);
    expect(q.noAsk).toBeGreaterThan(q.noBid);
    expect(q.yesMid).toBeGreaterThan(q.yesBid);
    expect(q.noMid).toBeGreaterThan(q.noBid);
  });

  it("executeBuyYes fills at ask plus impact when slippage and liquidity set", () => {
    const m = new SyntheticBinaryMarket({
      spreadBps: 20,
      slippageBps: 10,
      maxLiquidityPerTrade: 100,
    });
    m.setProbabilityUp(0.5);
    const q = m.getQuoteSnapshot();
    const small = m.executeBuyYes(10);
    expect(small.fillPrice).toBeGreaterThanOrEqual(q.yesAsk);
    const large = m.executeBuyYes(100);
    expect(large.fillPrice).toBeGreaterThan(small.fillPrice);
    expect(large.impactBps).toBeGreaterThanOrEqual(small.impactBps);
    expect(large.cost).toBeCloseTo(large.fillPrice * large.shares, 8);
    expect(large.effectiveEntryPrice).toBe(large.fillPrice);
  });

  it("executeBuyNo uses NO ask", () => {
    const m = new SyntheticBinaryMarket({ spreadBps: 30, slippageBps: 0, maxLiquidityPerTrade: 0 });
    m.setQuotedMids(0.55, 0.45);
    const q = m.getQuoteSnapshot();
    const ex = m.executeBuyNo(50);
    expect(ex.side).toBe("NO");
    expect(ex.fillPrice).toBeGreaterThanOrEqual(q.noAsk);
    expect(ex.cost).toBeCloseTo(ex.fillPrice * 50, 8);
  });

  it("toNormalizedSpotBook wraps YES leg", () => {
    const m = new SyntheticBinaryMarket({ spreadBps: 20, slippageBps: 0, maxLiquidityPerTrade: 0 });
    m.setProbabilityUp(0.52);
    const b = m.toNormalizedSpotBook("X", 1_700_000_000);
    expect(b).not.toBeNull();
    expect(b!.midPrice).toBeCloseTo(0.52, 6);
    expect(b!.bestAsk).toBeGreaterThan(b!.bestBid);
  });

  it("independent mids via setQuotedMids", () => {
    const m = new SyntheticBinaryMarket({ spreadBps: 10, slippageBps: 0, maxLiquidityPerTrade: 0 });
    m.setQuotedMids(0.52, 0.48);
    const q = m.getQuoteSnapshot();
    expect(q.yesMid).toBe(0.52);
    expect(q.noMid).toBe(0.48);
  });
});
