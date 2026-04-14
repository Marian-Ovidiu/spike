import { describe, expect, it } from "vitest";
import type { SimulatedTrade } from "./simulationEngine.js";
import {
  computeSimulationPerformance,
  SimulationEngine,
} from "./simulationEngine.js";

function trade(pl: number): SimulatedTrade {
  return {
    id: 1,
    direction: "UP",
    contracts: 1,
    entryPrice: 0,
    exitPrice: pl,
    profitLoss: pl,
    riskAtEntry: 0,
    exitReason: "profit",
    entryPath: "strong_spike_immediate",
    openedAt: 0,
    closedAt: 1,
  };
}

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

describe("SimulationEngine.onTradeClosed", () => {
  it("invokes callback when a silent engine closes a trade", () => {
    const closed: SimulatedTrade[] = [];
    const tickConfig = {
      exitPrice: 0.52,
      stopLoss: 0.085,
      exitTimeoutMs: 90_000,
      entryCooldownMs: 0,
      riskPercentPerTrade: 100,
    };
    const sim = new SimulationEngine({
      silent: true,
      initialEquity: 10_000,
      onTradeClosed: (t) => {
        closed.push(t);
      },
    });

    sim.onTick({
      now: 1_000,
      entry: {
        shouldEnter: true,
        direction: "UP",
        reasons: [],
        stableRangeDetected: true,
        priorRangePercent: 0.1,
        stableRangeQuality: "good",
        rangeDecisionNote: "test",
        movementClassification: "strong_spike",
        spikeDetected: true,
        movement: {
          strongestMovePercent: 0.01,
          strongestMoveAbsolute: 0.2,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.005,
          thresholdRatio: 2,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
        windowSpike: undefined,
      },
      sides: { upSidePrice: 0.2, downSidePrice: 0.5 },
      config: tickConfig,
    });
    expect(sim.getOpenPosition()).not.toBeNull();

    sim.onTick({
      now: 2_000,
      entry: {
        shouldEnter: false,
        direction: null,
        reasons: ["market_not_stable"],
        stableRangeDetected: false,
        priorRangePercent: 1.2,
        stableRangeQuality: "poor",
        rangeDecisionNote: "test",
        movementClassification: "no_signal",
        spikeDetected: false,
        movement: {
          strongestMovePercent: 0,
          strongestMoveAbsolute: 0,
          strongestMoveDirection: null,
          thresholdPercent: 0.005,
          thresholdRatio: 0,
          classification: "no_signal",
          sourceWindowLabel: null,
        },
        windowSpike: undefined,
      },
      sides: { upSidePrice: 0.55, downSidePrice: 0.45 },
      config: tickConfig,
    });

    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe("profit");
    expect(closed[0]!.id).toBe(1);
  });
});
