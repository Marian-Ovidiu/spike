import { describe, expect, it } from "vitest";

import { getPositionSize } from "./riskPositionSizing.js";

describe("getPositionSize", () => {
  const base = {
    accountBalance: 10_000,
    riskPercentPerTrade: 1,
    maxTradeSize: 500,
    minTradeSize: 10,
  };

  it("scales up with larger positive edge", () => {
    const low = getPositionSize({
      ...base,
      edge: 0.01,
      referenceEdge: 0.05,
    });
    const high = getPositionSize({
      ...base,
      edge: 0.1,
      referenceEdge: 0.05,
    });
    expect(high).toBeGreaterThan(low);
  });

  it("uses weak multiplier when edge <= 0", () => {
    const neg = getPositionSize({ ...base, edge: -0.02 });
    const zero = getPositionSize({ ...base, edge: 0 });
    expect(neg).toBe(zero);
  });

  it("respects min and max trade size", () => {
    expect(
      getPositionSize({
        accountBalance: 1_000_000,
        edge: 0.2,
        riskPercentPerTrade: 10,
        maxTradeSize: 80,
        minTradeSize: 5,
      })
    ).toBe(80);
    expect(
      getPositionSize({
        accountBalance: 100,
        edge: 0.001,
        riskPercentPerTrade: 0.01,
        maxTradeSize: 500,
        minTradeSize: 20,
      })
    ).toBe(20);
  });

  it("base risk is balance * riskPercent / 100 before edge mult", () => {
    const s = getPositionSize({
      accountBalance: 2000,
      edge: 0.03,
      riskPercentPerTrade: 2,
      maxTradeSize: 10_000,
      minTradeSize: 0,
      referenceEdge: 0.03,
    });
    expect(s).toBeCloseTo(40, 5);
  });
});
