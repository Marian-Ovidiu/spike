import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  maxDrawdownFromTrades,
  parseHistoricalPriceText,
  runBacktestReplay,
  runBinaryBacktestReplay,
} from "./backtest.js";
import { config as defaultAppConfig } from "./config.js";
import type { SimulatedTrade } from "./simulationEngine.js";

describe("parseHistoricalPriceText", () => {
  it("parses one column", () => {
    expect(parseHistoricalPriceText("1\n2\n3\n")).toEqual([1, 2, 3]);
  });

  it("parses CSV with header", () => {
    const csv = "time,price\n0,100\n1,101\n";
    expect(parseHistoricalPriceText(csv)).toEqual([100, 101]);
  });

  it("skips # comments", () => {
    expect(parseHistoricalPriceText("# x\n42\n")).toEqual([42]);
  });
});

describe("maxDrawdownFromTrades", () => {
  it("computes peak-to-trough on cumulative P/L", () => {
    const trades: SimulatedTrade[] = [
      {
        id: 1,
        direction: "UP",
        stake: 0,
        shares: 0,
        entryPrice: 0,
        exitPrice: 0,
        profitLoss: 10,
        equityBefore: 0,
        equityAfter: 10,
        riskAtEntry: 0,
        exitReason: "profit",
        entryPath: "strong_spike_immediate",
        openedAt: 0,
        closedAt: 1,
      },
      {
        id: 2,
        direction: "UP",
        stake: 0,
        shares: 0,
        entryPrice: 0,
        exitPrice: 0,
        profitLoss: -25,
        equityBefore: 10,
        equityAfter: -15,
        riskAtEntry: 0,
        exitReason: "stop",
        entryPath: "strong_spike_immediate",
        openedAt: 0,
        closedAt: 1,
      },
      {
        id: 3,
        direction: "UP",
        stake: 0,
        shares: 0,
        entryPrice: 0,
        exitPrice: 0,
        profitLoss: 5,
        equityBefore: -15,
        equityAfter: -10,
        riskAtEntry: 0,
        exitReason: "profit",
        entryPath: "strong_spike_immediate",
        openedAt: 0,
        closedAt: 1,
      },
    ];
    // equity: 10, -15, -10 → peak 10, max DD 25
    expect(maxDrawdownFromTrades(trades)).toBe(25);
  });
});

describe("runBacktestReplay", () => {
  const prevLegacy = process.env.LEGACY_SPOT_MARKET_MODE;
  beforeAll(() => {
    process.env.LEGACY_SPOT_MARKET_MODE = "1";
  });
  afterAll(() => {
    if (prevLegacy === undefined) delete process.env.LEGACY_SPOT_MARKET_MODE;
    else process.env.LEGACY_SPOT_MARKET_MODE = prevLegacy;
  });

  it("runs without throwing on synthetic prices", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 40_000 + i * 2);
    const r = runBacktestReplay(prices, {
      config: {
        spikeThreshold: 0.004,
        tradableSpikeMinPercent: 0.0015,
        maxPriorRangeForNormalEntry: 0.0015,
        hardRejectPriorRangePercent: 0.002,
        strongSpikeConfirmationTicks: 1,
        exceptionalSpikePercent: 0.0025,
        exceptionalSpikeOverridesCooldown: true,
        maxOppositeSideEntryPrice: 0.35,
        neutralQuoteBandMin: 0.45,
        neutralQuoteBandMax: 0.55,
        rangeThreshold: 0.0015,
        stableRangeSoftToleranceRatio: 1.5,
        strongSpikeHardRejectPoorRange: false,
        spikeMinRangeMultiple: 2.2,
        borderlineMinRatio: 0.85,
        borderlineWatchTicks: 2,
        borderlineRequirePause: true,
        borderlineRequireNoContinuation: true,
        borderlineContinuationThreshold: 0.25,
        borderlineReversionThreshold: 0.2,
        borderlinePauseBandPercent: 0.00015,
        entryPrice: 0.25,
        exitPrice: 0.5,
        stopLoss: 0.1,
        exitTimeoutMs: 60_000,
        entryCooldownMs: 0,
        initialCapital: 10_000,
        riskPercentPerTrade: 1,
        stakePerTrade: 5,
        priceBufferSize: 20,
        allowWeakQualityEntries: false,
        allowWeakQualityOnlyForStrongSpikes: true,
        weakQualitySizeMultiplier: 0.5,
        strongQualitySizeMultiplier: 1,
        exceptionalQualitySizeMultiplier: 1,
      },
      sides: { upSidePrice: 0.2, downSidePrice: 0.2 },
    });
    expect(r.totalTrades).toBeGreaterThanOrEqual(0);
    expect(r.totalEntries).toBeGreaterThanOrEqual(0);
    expect(r.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(r.strongSpike.signals).toBeGreaterThanOrEqual(0);
    expect(r.borderline.signals).toBeGreaterThanOrEqual(0);
    expect(r.combined.tradesClosed).toBe(r.totalTrades);
    expect(r.movement.noSignalMoves).toBeGreaterThanOrEqual(0);
    expect(r.blockers.blockedByInvalidQuotes).toBeGreaterThanOrEqual(0);
    expect(r.blockers.rejectedByWeakSpikeQuality).toBeGreaterThanOrEqual(0);
    expect(r.blockers.rejectedByPriorRangeTooWide).toBeGreaterThanOrEqual(0);
    expect(r.blockers.rejectedByHardUnstableContext).toBeGreaterThanOrEqual(0);
    expect(r.blockers.rejectedByStrongSpikeContinuation).toBeGreaterThanOrEqual(0);
    expect(r.blockers.rejectedByBorderlineContinuation).toBeGreaterThanOrEqual(0);
    expect(r.blockers.rejectedByExpensiveOppositeSide).toBeGreaterThanOrEqual(0);
    expect(r.blockers.exceptionalSpikeSignals).toBeGreaterThanOrEqual(0);
    expect(r.blockers.exceptionalSpikeEntries).toBeGreaterThanOrEqual(0);
    expect(typeof r.evaluationNote).toBe("string");
    expect(r.weakSpike.signals).toBeGreaterThanOrEqual(0);
    expect(r.weakSpike.rejected).toBeGreaterThanOrEqual(0);
    expect(r.weakSpike.rejectionRate).toBeGreaterThanOrEqual(0);
    expect(Object.keys(r.rejectionReasonBreakdown).length).toBeGreaterThanOrEqual(0);
    expect(r.comparison).toBeDefined();
    expect(r.noiseComparison).toBeDefined();
  });

  it("tracks strong and borderline stats separately", () => {
    const prices = [
      100_000,
      100_010,
      100_020,
      100_050,
      100_093,
      100_095,
      100_120,
      100_080,
      100_130,
      100_090,
      100_150,
      100_100,
      100_160,
      100_120,
      100_170,
      100_130,
      100_180,
      100_140,
      100_190,
      100_150,
      100_200,
      100_160,
      100_210,
      100_170,
      100_220,
    ];
    const r = runBacktestReplay(prices, {
      config: {
        spikeThreshold: 0.001,
        tradableSpikeMinPercent: 0.0015,
        maxPriorRangeForNormalEntry: 0.0015,
        hardRejectPriorRangePercent: 0.002,
        strongSpikeConfirmationTicks: 1,
        exceptionalSpikePercent: 0.0025,
        exceptionalSpikeOverridesCooldown: true,
        maxOppositeSideEntryPrice: 0.35,
        neutralQuoteBandMin: 0.45,
        neutralQuoteBandMax: 0.55,
        rangeThreshold: 0.02,
        stableRangeSoftToleranceRatio: 1.5,
        strongSpikeHardRejectPoorRange: false,
        spikeMinRangeMultiple: 1.0,
        borderlineMinRatio: 0.85,
        borderlineWatchTicks: 2,
        borderlineRequirePause: true,
        borderlineRequireNoContinuation: true,
        borderlineContinuationThreshold: 0.25,
        borderlineReversionThreshold: 0.2,
        borderlinePauseBandPercent: 0.0002,
        entryPrice: 0.25,
        exitPrice: 0.5,
        stopLoss: 0.1,
        exitTimeoutMs: 60_000,
        entryCooldownMs: 0,
        initialCapital: 10_000,
        riskPercentPerTrade: 1,
        stakePerTrade: 5,
        priceBufferSize: 20,
        allowWeakQualityEntries: false,
        allowWeakQualityOnlyForStrongSpikes: true,
        weakQualitySizeMultiplier: 0.5,
        strongQualitySizeMultiplier: 1,
        exceptionalQualitySizeMultiplier: 1,
      },
      sides: { upSidePrice: 0.2, downSidePrice: 0.2 },
    });
    expect(r.strongSpike.signals).toBeGreaterThanOrEqual(0);
    expect(r.strongSpike.entries).toBeGreaterThanOrEqual(0);
    expect(r.borderline.signals).toBeGreaterThanOrEqual(0);
    expect(r.borderline.candidatesCreated).toBeGreaterThanOrEqual(0);
    expect(r.borderline.promotions).toBeGreaterThanOrEqual(0);
    expect(r.borderline.cancellations).toBeGreaterThanOrEqual(0);
    expect(r.borderline.expirations).toBeGreaterThanOrEqual(0);
    expect(
      r.strongSpike.tradesClosed + r.borderline.tradesClosed
    ).toBe(r.combined.tradesClosed);
    expect(
      r.movement.noSignalMoves + r.movement.borderlineMoves + r.movement.strongSpikeMoves
    ).toBeGreaterThan(0);
    expect(r.comparison?.relaxed.totalTrades).toBe(r.totalTrades);
  });
});

describe("runBinaryBacktestReplay", () => {
  it("exposes binary_run_analytics_v3 and marks closed trades as binary execution", () => {
    const prices = Array.from({ length: 45 }, (_, i) => 40_000 + i * 3 + (i > 38 ? 120 : 0));
    const r = runBinaryBacktestReplay(prices, {
      config: defaultAppConfig,
      includeStrictComparison: false,
    });
    expect(r.binaryRunAnalytics?.schema).toBe("binary_run_analytics_v3");
    expect(r.evaluationNote).toContain("binary");
    for (const t of r.trades) {
      expect(t.executionModel).toBe("binary");
    }
  });
});
