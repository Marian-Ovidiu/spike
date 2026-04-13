import { describe, expect, it } from "vitest";
import {
  extractUsdLevelsFromQuestion,
  selectMarketNearestBtcLevel,
} from "./polymarketGamma.js";
import type { GammaMarket } from "./polymarketGamma.js";

function m(
  id: string,
  question: string,
  volume: number,
  closed = false
): GammaMarket {
  return {
    id,
    slug: id,
    question,
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.5","0.5"]',
    volumeNum: volume,
    active: true,
    closed,
  };
}

describe("extractUsdLevelsFromQuestion", () => {
  it("parses $100k and comma amounts", () => {
    expect(
      extractUsdLevelsFromQuestion("Will BTC hit $100,000 before 2027?")
    ).toContain(100_000);
    expect(extractUsdLevelsFromQuestion("Strike $95k today")).toContain(95_000);
  });
});

describe("selectMarketNearestBtcLevel", () => {
  it("prefers market whose strike is closest to spot", () => {
    const markets = [
      m("1", "Will Bitcoin reach $200,000 in 2025?", 1e6),
      m("2", "Will Bitcoin reach $95,000 in 2025?", 500),
    ];
    const spot = 96_000;
    const picked = selectMarketNearestBtcLevel(spot, markets);
    expect(picked?.id).toBe("2");
  });
});
