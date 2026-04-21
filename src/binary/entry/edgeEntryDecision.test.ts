import { describe, expect, it } from "vitest";

import {
  binaryLegFromDirection,
  estimateOutcomeAskFromMid,
  formatEdgeEntryLogLine,
  resolveBinaryVenueAsks,
  shouldEnterTrade,
} from "./edgeEntryDecision.js";

describe("shouldEnterTrade", () => {
  it("enters YES when mean-reversion edge exceeds threshold", () => {
    const r = shouldEnterTrade({
      estimatedProbabilityUp: 0.4,
      marketPriceYesAsk: 0.52,
      marketPriceNoAsk: 0.48,
      minEdgeThreshold: 0.03,
      side: "YES",
    });
    expect(r.probability).toBeCloseTo(0.6, 6);
    expect(r.edge).toBeCloseTo(0.08, 6);
    expect(r.shouldEnter).toBe(true);
    expect(r.decision).toBe("enter");
  });

  it("skips YES when mean-reversion edge is not strictly greater than threshold", () => {
    const r = shouldEnterTrade({
      estimatedProbabilityUp: 0.47,
      marketPriceYesAsk: 0.52,
      marketPriceNoAsk: 0.48,
      minEdgeThreshold: 0.03,
      side: "YES",
    });
    expect(r.probability).toBeCloseTo(0.53, 6);
    expect(r.edge).toBeCloseTo(0.01, 6);
    expect(r.shouldEnter).toBe(false);
    expect(r.decision).toBe("skip");
  });

  it("uses p_up on NO leg under mean-reversion (fade: buy NO when momentum is up)", () => {
    const r = shouldEnterTrade({
      estimatedProbabilityUp: 0.66,
      marketPriceYesAsk: 0.36,
      marketPriceNoAsk: 0.62,
      minEdgeThreshold: 0.02,
      side: "NO",
    });
    expect(r.probability).toBeCloseTo(0.66, 6);
    expect(r.marketPrice).toBe(0.62);
    expect(r.edge).toBeCloseTo(0.04, 6);
    expect(r.shouldEnter).toBe(true);
  });

  it("momentum mode keeps P(YES)=p_up and P(NO)=1−p_up", () => {
    const r = shouldEnterTrade({
      estimatedProbabilityUp: 0.58,
      marketPriceYesAsk: 0.52,
      marketPriceNoAsk: 0.48,
      minEdgeThreshold: 0.03,
      side: "YES",
      edgeProbabilityModel: "momentum",
    });
    expect(r.probability).toBeCloseTo(0.58, 6);
    expect(r.edge).toBeCloseTo(0.06, 6);
    expect(r.shouldEnter).toBe(true);
  });

  it("disables gate when minEdgeThreshold <= 0", () => {
    const r = shouldEnterTrade({
      estimatedProbabilityUp: 0.4,
      marketPriceYesAsk: 0.55,
      marketPriceNoAsk: 0.45,
      minEdgeThreshold: 0,
      side: "YES",
    });
    expect(r.shouldEnter).toBe(true);
    expect(r.decision).toBe("enter");
  });

  it("formatEdgeEntryLogLine includes decision", () => {
    const line = formatEdgeEntryLogLine(
      shouldEnterTrade({
        estimatedProbabilityUp: 0.5,
        marketPriceYesAsk: 0.52,
        marketPriceNoAsk: 0.48,
        minEdgeThreshold: 0.1,
        side: "YES",
      })
    );
    expect(line).toContain("skip");
    expect(line).toContain("edge=");
  });
});

describe("resolveBinaryVenueAsks", () => {
  it("uses execution bestAsk for YES and synthetic NO ask", () => {
    const a = resolveBinaryVenueAsks({
      executionBook: {
        bestBid: 0.49,
        bestAsk: 0.51,
        midPrice: 0.5,
        spreadBps: 400,
      },
      yesMid: 0.5,
      noMid: 0.48,
    });
    expect(a.yesAsk).toBe(0.51);
    expect(a.noAsk).toBeGreaterThan(0.48);
    expect(a.noAsk).toBeCloseTo(estimateOutcomeAskFromMid(0.48, 400), 8);
  });
});

describe("binaryLegFromDirection", () => {
  it("maps UP to YES", () => {
    expect(binaryLegFromDirection("UP")).toBe("YES");
    expect(binaryLegFromDirection("DOWN")).toBe("NO");
  });
});
