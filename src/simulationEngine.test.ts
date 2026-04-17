import { describe, expect, it } from "vitest";
import type { SimulatedTrade } from "./simulationEngine.js";
import {
  buildTransparentTradeLog,
  computePerformanceFromClosedTrades,
  computeSimulationPerformance,
  quotePriceForPositionDirection,
  selectPositionQuote,
  SimulationEngine,
} from "./simulationEngine.js";
import { syntheticSpotBookFromMid } from "./spotSpreadFilter.js";

const SYM = "BTCUSDT";

const spotTickConfig = {
  takeProfitBps: 35,
  stopLossBps: 25,
  paperSlippageBps: 0,
  paperFeeRoundTripBps: 0,
  exitTimeoutMs: 0,
  entryCooldownMs: 0,
  stakePerTrade: 5,
  allowWeakQualityEntries: false,
  weakQualitySizeMultiplier: 0.5,
  strongQualitySizeMultiplier: 1,
  exceptionalQualitySizeMultiplier: 1,
} as const;

function trade(pl: number): SimulatedTrade {
  return {
    id: 1,
    symbol: SYM,
    direction: "UP",
    stake: 1,
    shares: 1,
    entryPrice: 0,
    exitPrice: pl,
    grossPnl: pl,
    feesEstimate: 0,
    profitLoss: pl,
    equityBefore: 1000,
    equityAfter: 1000 + pl,
    riskAtEntry: 0,
    exitReason: "profit",
    entryPath: "strong_spike_immediate",
    openedAt: 0,
    closedAt: 1,
  };
}

describe("buildTransparentTradeLog", () => {
  it("matches manual pnl and equity roll-forward", () => {
    const t: SimulatedTrade = {
      id: 7,
      symbol: SYM,
      direction: "UP",
      stake: 5,
      shares: 5 / 0.48,
      entryPrice: 0.48,
      exitPrice: 0.52,
      grossPnl: (5 / 0.48) * (0.52 - 0.48),
      feesEstimate: 0,
      profitLoss: (5 / 0.48) * (0.52 - 0.48),
      equityBefore: 10_000,
      equityAfter: 10_000 + (5 / 0.48) * (0.52 - 0.48),
      riskAtEntry: 0,
      exitReason: "profit",
      entryPath: "strong_spike_immediate",
      openedAt: 1,
      closedAt: 2,
    };
    const log = buildTransparentTradeLog(t);
    expect(log.pnl).toBeCloseTo(log.shares * (log.exitPrice - log.entryPrice), 10);
    expect(log.equityAfter).toBeCloseTo(log.equityBefore + log.pnl, 10);
    expect(log.tradeId).toBe(7);
    expect(log.reasonEntry).toBe("strong_spike_immediate");
    expect(log.reasonExit).toBe("profit");
  });
});

describe("computePerformanceFromClosedTrades", () => {
  it("matches sum of trade P/L and replayed max drawdown", () => {
    const initial = 10_000;
    const trades = [
      {
        id: 1,
        symbol: SYM,
        direction: "UP" as const,
        stake: 5,
        shares: 10,
        entryPrice: 0.5,
        exitPrice: 0.55,
        grossPnl: 0.5,
        feesEstimate: 0,
        profitLoss: 0.5,
        equityBefore: initial,
        equityAfter: initial + 0.5,
        riskAtEntry: 0,
        exitReason: "profit" as const,
        entryPath: "strong_spike_immediate" as const,
        openedAt: 1,
        closedAt: 2,
      },
      {
        id: 2,
        symbol: SYM,
        direction: "UP" as const,
        stake: 5,
        shares: 10,
        entryPrice: 0.5,
        exitPrice: 0.45,
        grossPnl: -0.5,
        feesEstimate: 0,
        profitLoss: -0.5,
        equityBefore: initial + 0.5,
        equityAfter: initial,
        riskAtEntry: 0,
        exitReason: "stop" as const,
        entryPath: "strong_spike_immediate" as const,
        openedAt: 3,
        closedAt: 4,
      },
    ];
    const p = computePerformanceFromClosedTrades(trades, initial);
    const sumPnL = trades.reduce((a, t) => a + t.profitLoss, 0);
    expect(p.totalProfit).toBeCloseTo(sumPnL, 10);
    expect(p.currentEquity).toBeCloseTo(initial + sumPnL, 10);
    expect(p.maxEquityDrawdown).toBeCloseTo(0.5, 10);
    expect(p.totalTrades).toBe(2);
    expect(p.wins).toBe(1);
    expect(p.losses).toBe(1);
  });
});

describe("computeSimulationPerformance", () => {
  it("counts wins, losses, breakeven, win rate, totals, and average", () => {
    const trades: SimulatedTrade[] = [
      trade(0.1),
      trade(-0.05),
      trade(0),
      trade(0.2),
    ];
    const s = computeSimulationPerformance(trades);
    expect(s.totalTrades).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.breakeven).toBe(1);
    expect(s.winRate).toBeCloseTo(50, 5);
    expect(s.totalProfit).toBeCloseTo(0.25, 5);
    expect(s.averageProfitPerTrade).toBeCloseTo(0.0625, 5);
  });

  it("returns zeros for empty history", () => {
    const s = computeSimulationPerformance([]);
    expect(s.totalTrades).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.totalProfit).toBe(0);
    expect(s.averageProfitPerTrade).toBe(0);
  });
});

const entryOpenUp = {
  shouldEnter: true,
  direction: "UP" as const,
  reasons: [] as string[],
  stableRangeDetected: true,
  priorRangeFraction: 0.1,
  stableRangeQuality: "good" as const,
  rangeDecisionNote: "test",
  movementClassification: "strong_spike" as const,
  spikeDetected: true,
  movement: {
    strongestMovePercent: 0.01,
    strongestMoveAbsolute: 0.2,
    strongestMoveDirection: "UP" as const,
    thresholdPercent: 0.005,
    thresholdRatio: 2,
    classification: "strong_spike" as const,
    sourceWindowLabel: "tick-1",
  },
  windowSpike: undefined,
};

const entryFlat = {
  shouldEnter: false,
  direction: null,
  reasons: ["market_not_stable"],
  stableRangeDetected: false,
  priorRangeFraction: 1.2,
  stableRangeQuality: "poor" as const,
  rangeDecisionNote: "test",
  movementClassification: "no_signal" as const,
  spikeDetected: false,
  movement: {
    strongestMovePercent: 0,
    strongestMoveAbsolute: 0,
    strongestMoveDirection: null,
    thresholdPercent: 0.005,
    thresholdRatio: 0,
    classification: "no_signal" as const,
    sourceWindowLabel: null,
  },
  windowSpike: undefined,
};

describe("SimulationEngine.onTradeClosed", () => {
  it("invokes callback when a silent engine closes a trade", () => {
    const closed: SimulatedTrade[] = [];
    const sim = new SimulationEngine({
      silent: true,
      initialEquity: 10_000,
      onTradeClosed: (t) => {
        closed.push(t);
      },
    });

    const openBk = syntheticSpotBookFromMid(100, 5);
    sim.onTick({
      now: 1_000,
      entry: entryOpenUp,
      sides: openBk,
      symbol: SYM,
      config: spotTickConfig,
    });
    expect(sim.getOpenPosition()).not.toBeNull();

    sim.onTick({
      now: 2_000,
      entry: entryFlat,
      sides: syntheticSpotBookFromMid(100.2, 5),
      symbol: SYM,
      config: spotTickConfig,
    });

    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe("timeout");
    expect(closed[0]!.id).toBe(1);
    expect(closed[0]!.equityAfter).toBeCloseTo(
      closed[0]!.equityBefore + closed[0]!.profitLoss,
      10
    );
  });

  it("uses fixed stake with spot fill and timeout exit", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const openBk = syntheticSpotBookFromMid(100, 5);
    sim.onTick({
      now: 1_000,
      entry: entryOpenUp,
      sides: openBk,
      symbol: SYM,
      config: spotTickConfig,
    });
    expect(sim.getOpenPosition()).not.toBeNull();
    sim.onTick({
      now: 2_000,
      entry: entryFlat,
      sides: syntheticSpotBookFromMid(100.2, 5),
      symbol: SYM,
      config: spotTickConfig,
    });
    const trades = sim.getTradeHistory();
    expect(trades).toHaveLength(1);
    expect(trades[0]!.stake).toBe(5);
    expect(trades[0]!.exitReason).toBe("timeout");
  });

  it("halves stake when weak quality and allow-weak sizing is enabled", () => {
    const tickConfig = {
      ...spotTickConfig,
      stakePerTrade: 10,
      allowWeakQualityEntries: true,
    };
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    sim.onTick({
      now: 1_000,
      entry: entryOpenUp,
      entryQualityProfile: "weak",
      sides: syntheticSpotBookFromMid(100, 5),
      symbol: SYM,
      config: tickConfig,
    });
    expect(sim.getOpenPosition()?.stake).toBe(5);
    sim.onTick({
      now: 2_000,
      entry: entryFlat,
      sides: syntheticSpotBookFromMid(100.2, 5),
      symbol: SYM,
      config: tickConfig,
    });
    const trades = sim.getTradeHistory();
    expect(trades[0]!.stake).toBe(5);
    expect(trades[0]!.baseStakePerTrade).toBe(10);
    expect(trades[0]!.qualityStakeMultiplier).toBe(0.5);
    expect(trades[0]!.entryQualityProfile).toBe("weak");
    expect(trades[0]!.riskAtEntry).toBe(5);
  });
});

describe("quotePriceForPositionDirection", () => {
  const book = syntheticSpotBookFromMid(100, 10);

  it("UP → mark on bid", () => {
    expect(quotePriceForPositionDirection("UP", book)).toBe(book.bestBid);
    const s = selectPositionQuote("UP", book);
    expect(s.entrySide).toBe("ask");
    expect(s.markSide).toBe("bid");
    expect(s.fillReference).toBeGreaterThan(0);
  });

  it("DOWN → mark on ask", () => {
    expect(quotePriceForPositionDirection("DOWN", book)).toBe(book.bestAsk);
    const s = selectPositionQuote("DOWN", book);
    expect(s.entrySide).toBe("bid");
    expect(s.markSide).toBe("ask");
  });
});

describe("SimulationEngine held-leg integration", () => {
  const tickConfig = {
    ...spotTickConfig,
    takeProfitBps: 500,
    stopLossBps: 500,
  };

  it("DOWN position: profit exit when ask drops enough", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const entryDown = {
      shouldEnter: true,
      direction: "DOWN" as const,
      reasons: [] as string[],
      stableRangeDetected: true,
      priorRangeFraction: 0.1,
      stableRangeQuality: "good" as const,
      rangeDecisionNote: "test",
      movementClassification: "strong_spike" as const,
      spikeDetected: true,
      movement: {
        strongestMovePercent: 0.01,
        strongestMoveAbsolute: 0.2,
        strongestMoveDirection: "DOWN" as const,
        thresholdPercent: 0.005,
        thresholdRatio: 2,
        classification: "strong_spike" as const,
        sourceWindowLabel: "tick-1",
      },
      windowSpike: undefined,
    };
    sim.onTick({
      now: 1_000,
      entry: entryDown,
      sides: syntheticSpotBookFromMid(100, 5),
      symbol: SYM,
      config: tickConfig,
    });
    const ep = sim.getOpenPosition()!.entryPrice;
    sim.onTick({
      now: 2_000,
      entry: entryFlat,
      sides: syntheticSpotBookFromMid(94, 5),
      symbol: SYM,
      config: tickConfig,
    });
    const t = sim.getTradeHistory()[0]!;
    expect(t.exitReason).toBe("profit");
    expect(t.profitLoss).toBeCloseTo(t.shares * (ep - t.exitPrice), 6);
  });

  it("UP position: profit when bid rises past TP", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    sim.onTick({
      now: 1_000,
      entry: entryOpenUp,
      sides: syntheticSpotBookFromMid(100, 5),
      symbol: SYM,
      config: tickConfig,
    });
    sim.onTick({
      now: 2_000,
      entry: entryFlat,
      sides: syntheticSpotBookFromMid(106, 5),
      symbol: SYM,
      config: tickConfig,
    });
    const t = sim.getTradeHistory()[0]!;
    expect(t.exitReason).toBe("profit");
  });
});
