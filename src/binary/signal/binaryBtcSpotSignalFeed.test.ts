import { describe, expect, it } from "vitest";

import { PaperBinanceFeed } from "../../adapters/binanceSpotFeed.js";
import { BinaryBtcSpotSignalFeed } from "./binaryBtcSpotSignalFeed.js";

describe("BinaryBtcSpotSignalFeed", () => {
  it("wraps inner feed and never exposes binary outcome prices", () => {
    const inner = new PaperBinanceFeed({ symbol: "BTCUSDT" });
    const feed = new BinaryBtcSpotSignalFeed(inner);
    expect(feed.getSymbol()).toBe(inner.getSymbol());
    expect(feed.getBinaryOutcomePrices()).toBeNull();
  });
});
