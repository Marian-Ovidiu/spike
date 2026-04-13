import { describe, expect, it } from "vitest";
import {
  maxDrawdownFromTrades,
  parseHistoricalPriceText,
  runBacktestReplay,
} from "./backtest.js";
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
        entryPrice: 0,
        exitPrice: 0,
        profitLoss: 10,
        exitReason: "profit",
        openedAt: 0,
        closedAt: 1,
      },
      {
        id: 2,
        direction: "UP",
        entryPrice: 0,
        exitPrice: 0,
        profitLoss: -25,
        exitReason: "stop",
        openedAt: 0,
        closedAt: 1,
      },
      {
        id: 3,
        direction: "UP",
        entryPrice: 0,
        exitPrice: 0,
        profitLoss: 5,
        exitReason: "profit",
        openedAt: 0,
        closedAt: 1,
      },
    ];
    // equity: 10, -15, -10 → peak 10, max DD 25
    expect(maxDrawdownFromTrades(trades)).toBe(25);
  });
});

describe("runBacktestReplay", () => {
  it("runs without throwing on synthetic prices", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 40_000 + i * 2);
    const r = runBacktestReplay(prices, {
      config: {
        spikeThreshold: 0.004,
        rangeThreshold: 0.0015,
        spikeMinRangeMultiple: 2.2,
        entryPrice: 0.25,
        exitPrice: 0.5,
        stopLoss: 0.1,
        exitTimeoutMs: 60_000,
        entryCooldownMs: 0,
        initialCapital: 10_000,
        riskPercentPerTrade: 1,
        priceBufferSize: 20,
      },
      sides: { upSidePrice: 0.2, downSidePrice: 0.2 },
    });
    expect(r.totalTrades).toBeGreaterThanOrEqual(0);
    expect(r.maxDrawdown).toBeGreaterThanOrEqual(0);
  });
});
