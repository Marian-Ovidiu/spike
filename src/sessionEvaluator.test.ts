import { describe, expect, it } from "vitest";

import { evaluateSession } from "./sessionEvaluator.js";
import type { Opportunity } from "./opportunityTracker.js";
import type { SimulatedTrade } from "./simulationEngine.js";

function opp(
  ts: number,
  spikePct: number,
  status: "valid" | "rejected"
): Opportunity {
  return {
    timestamp: ts,
    btcPrice: 100_000,
    previousPrice: 99_000,
    currentPrice: 100_000 + spikePct * 1000,
    spikeDirection: "UP",
    spikePercent: spikePct,
    priorRangeFraction: 0.05,
    upSidePrice: 0.3,
    downSidePrice: 0.25,
    stableRangeDetected: true,
    spikeDetected: true,
    entryAllowed: status === "valid",
    entryRejectionReasons: [],
    status,
  };
}

function trade(pl: number): SimulatedTrade {
  return {
    id: 1,
    direction: "UP",
    stake: 1,
    shares: 1,
    entryPrice: 0.2,
    exitPrice: 0.5,
    profitLoss: pl,
    equityBefore: 1000,
    equityAfter: 1000 + pl,
    riskAtEntry: 0.05,
    exitReason: pl >= 0 ? "profit" : "stop",
    entryPath: "strong_spike_immediate",
    openedAt: 1000,
    closedAt: 2000,
  };
}

describe("evaluateSession", () => {
  it("computes conversion and profit factor", () => {
    const opps = [opp(1000, 0.5, "valid"), opp(2000, 0.8, "rejected")];
    const trades: SimulatedTrade[] = [trade(0.5)];
    const e = evaluateSession({
      opportunities: opps,
      trades,
    });
    expect(e.rawOpportunityCount).toBe(2);
    expect(e.opportunityToTradeConversion).toBeCloseTo(0.5);
    expect(e.totalProfit).toBe(0.5);
    expect(e.winRate).toBe(100);
    expect(e.profitFactor).toBe(Number.POSITIVE_INFINITY);
    expect(e.grossProfit).toBe(0.5);
    expect(e.grossLoss).toBe(0);
  });

  it("average gap between opportunities", () => {
    const opps = [opp(1000, 0.1, "rejected"), opp(4000, 0.2, "rejected")];
    const e = evaluateSession({
      opportunities: opps,
      trades: [],
    });
    expect(e.avgMsBetweenOpportunities).toBe(3000);
  });

  it("profit factor with wins and losses", () => {
    const trades: SimulatedTrade[] = [
      { ...trade(1), id: 1 },
      { ...trade(-0.5), id: 2, profitLoss: -0.5, exitReason: "stop" },
    ];
    const e = evaluateSession({
      opportunities: [opp(1, 0.5, "valid")],
      trades,
    });
    expect(e.profitFactor).toBeCloseTo(1 / 0.5);
    expect(e.grossProfit).toBe(1);
    expect(e.grossLoss).toBeCloseTo(0.5);
  });

  it("verdict neutral with no trades", () => {
    const e = evaluateSession({
      opportunities: [opp(1, 0.5, "rejected")],
      trades: [],
    });
    expect(e.verdict).toBe("neutral");
  });
});
