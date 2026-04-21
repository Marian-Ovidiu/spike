import { describe, expect, it } from "vitest";

import { classifyInvalidMarketPricesSubreason } from "./invalidMarketPricesAudit.js";

describe("classifyInvalidMarketPricesSubreason", () => {
  it("flags inverted book before spread", () => {
    const r = classifyInvalidMarketPricesSubreason({
      book: {
        bestBid: 0.55,
        bestAsk: 0.5,
        midPrice: 0.52,
        spreadBps: 30,
      },
      maxEntrySpreadBps: 500,
      yesMid: 0.52,
      noMid: 0.48,
      direction: "UP",
      slippageBps: 3,
      estimatedProbabilityUp: 0.5,
    });
    expect(r.subreason).toBe("invalid_crossed_or_inverted_book");
    expect(r.rawGateReason).toBe("invalid_book");
  });

  it("flags extreme spread when book is otherwise coherent", () => {
    const r = classifyInvalidMarketPricesSubreason({
      book: {
        bestBid: 0.49,
        bestAsk: 0.51,
        midPrice: 0.5,
        spreadBps: 900,
      },
      maxEntrySpreadBps: 30,
      yesMid: 0.5,
      noMid: 0.5,
      direction: "UP",
      slippageBps: 3,
      estimatedProbabilityUp: 0.55,
    });
    expect(r.subreason).toBe("invalid_market_price_extreme_reprice");
    expect(r.rawGateReason).toBe("spread_too_wide");
  });

  it("flags YES/NO sum drift", () => {
    const r = classifyInvalidMarketPricesSubreason({
      book: {
        bestBid: 0.49,
        bestAsk: 0.51,
        midPrice: 0.5,
        spreadBps: 20,
      },
      maxEntrySpreadBps: 200,
      yesMid: 0.6,
      noMid: 0.55,
      direction: "DOWN",
      slippageBps: 3,
      estimatedProbabilityUp: 0.5,
    });
    expect(r.subreason).toBe("invalid_yes_no_bounds");
  });
});
