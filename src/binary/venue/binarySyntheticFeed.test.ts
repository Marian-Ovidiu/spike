import { afterEach, describe, it, expect, vi } from "vitest";

import { BinarySyntheticFeed } from "./binarySyntheticFeed.js";

describe("BinarySyntheticFeed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a synthetic bid/ask around UP mid", () => {
    const f = new BinarySyntheticFeed({
      symbol: "TEST",
      upPrice: 0.5,
      downPrice: 0.5,
      syntheticSpreadBps: 20,
    });
    const b = f.getNormalizedBook();
    expect(b).not.toBeNull();
    expect(b!.midPrice).toBe(0.5);
    expect(b!.bestAsk).toBeGreaterThan(b!.bestBid);
    expect(Number.isFinite(b!.spreadBps)).toBe(true);
  });

  it("updates shutdown diagnostics after setOutcomePrices", () => {
    const f = new BinarySyntheticFeed({
      symbol: "X",
      upPrice: 0.4,
      downPrice: 0.6,
      syntheticSpreadBps: 10,
    });
    f.setOutcomePrices(0.55, 0.45);
    const d = f.getShutdownDiagnostics();
    expect(d.mode).toBe("binary");
    expect(d.upPrice).toBe(0.55);
    expect(d.downPrice).toBe(0.45);
  });

  it("applySignalProbability updates YES mid and normalized book", () => {
    const f = new BinarySyntheticFeed({
      symbol: "T",
      upPrice: 0.5,
      downPrice: 0.5,
      syntheticSpreadBps: 20,
    });
    const before = f.getNormalizedBook()!;
    expect(before.midPrice).toBe(0.5);
    f.applySignalProbability(0.72, 9_000_000);
    const after = f.getNormalizedBook()!;
    expect(after.midPrice).toBeCloseTo(0.72, 6);
    expect(after.bestAsk).toBeGreaterThan(after.bestBid);
    expect(f.getBinaryOutcomePrices().yesPrice).toBeCloseTo(0.72, 6);
    expect(f.getBinaryOutcomePrices().noPrice).toBeCloseTo(0.28, 6);
  });

  it("exposes venue snapshot with edge vs asks", () => {
    const f = new BinarySyntheticFeed({
      symbol: "T",
      upPrice: 0.5,
      downPrice: 0.5,
      syntheticSpreadBps: 20,
    });
    f.applySignalProbability(0.6, 1);
    const snap = f.getSyntheticVenueSnapshot();
    expect(snap).not.toBeNull();
    if (!snap) return;
    expect(snap.strategyProbabilityUp).toBeCloseTo(0.6, 6);
    expect(snap.fairValueYes).toBeCloseTo(0.6, 6);
    expect(snap.syntheticYesAsk).toBeGreaterThan(snap.syntheticYesMid);
    expect(Number.isFinite(snap.edgeVsYesAsk)).toBe(true);
  });

  it("venue can lag fair when lagTicks>0", () => {
    const f = new BinarySyntheticFeed({
      symbol: "T",
      upPrice: 0.5,
      downPrice: 0.5,
      syntheticSpreadBps: 10,
      venuePricing: { lagTicks: 1, reactionAlpha: 1, noiseBps: 0, biasBps: 0 },
    });
    f.applySignalProbability(0.9, 1);
    const midAfterHigh = f.getNormalizedBook()!.midPrice;
    f.applySignalProbability(0.1, 2);
    const snap = f.getSyntheticVenueSnapshot()!;
    expect(snap.laggedFairValueYes).toBeGreaterThan(0.5);
    expect(midAfterHigh).toBeGreaterThan(0.85);
    expect(snap.fairValueYes).toBeLessThan(0.2);
  });

  it("widens spread when volatility widening is enabled and fair jumps", () => {
    vi.stubEnv("SYNTHETIC_MARKET_WIDEN_ON_VOLATILITY", "1");
    vi.stubEnv("SYNTHETIC_MARKET_PROFILE", "");
    const f = new BinarySyntheticFeed({
      symbol: "T",
      upPrice: 0.5,
      downPrice: 0.5,
      syntheticSpreadBps: 25,
      venuePricing: { lagTicks: 0, reactionAlpha: 1, noiseBps: 0, biasBps: 0 },
    });
    const base = f.getSyntheticMarket().getBaseSpreadBps();
    expect(base).toBe(25);
    f.applySignalProbability(0.5, 1);
    expect(f.getSyntheticMarket().getSpreadBps()).toBe(25);
    f.applySignalProbability(0.95, 2);
    f.applySignalProbability(0.08, 3);
    const spr = f.getSyntheticMarket().getSpreadBps();
    expect(spr).toBeGreaterThanOrEqual(base);
    expect(spr).toBeLessThanOrEqual(f.getSyntheticMarket().getMaxSpreadBps());
    const diag = f.getSyntheticPricingDiagnosticsSummary();
    expect(diag).not.toBeNull();
    expect(diag!.ticksObserved).toBe(3);
    expect(diag!.meanSpreadBps).toBeGreaterThan(0);
  });

  it("exposes SyntheticBinaryMarket for execution simulation", () => {
    const f = new BinarySyntheticFeed({
      symbol: "T",
      upPrice: 0.5,
      downPrice: 0.48,
      syntheticSpreadBps: 20,
      syntheticSlippageBps: 5,
      maxLiquidityPerTrade: 200,
    });
    const mk = f.getSyntheticMarket();
    const ex = mk.executeBuyYes(100);
    expect(ex.cost).toBeGreaterThan(0);
    expect(f.getShutdownDiagnostics()).toMatchObject({
      syntheticSlippageBps: 5,
      maxLiquidityPerTrade: 200,
    });
  });
});
