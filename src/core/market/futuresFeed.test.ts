import { describe, expect, it } from "vitest";
import { createFuturesPaperMarketFeed } from "./futuresFeed.js";

describe("FuturesMarketFeed", () => {
  it("exposes futures-native contract metadata and capability flags", () => {
    const feed = createFuturesPaperMarketFeed({
      symbol: "BTCUSDT",
      initialSignalMid: 100,
      initialSpreadBps: 2,
    });

    expect(feed.contract.kind).toBe("perpetual_swap");
    expect(feed.contract.instrumentType).toBe("perpetual_swap");
    expect(feed.contract.settlementAsset).toBe("USDT");
    expect(feed.capabilities.supportsMarkPrice).toBe(true);
    expect(feed.capabilities.supportsIndexPrice).toBe(true);
    expect(feed.capabilities.supportsTopOfBookOnly).toBe(true);
    expect(feed.capabilities.supportsDepth).toBe(false);
    expect(feed.priceSources.signalPrice).toBe("synthetic_signal_mid");
    expect(feed.priceSources.executionBook).toBe("synthetic_execution_book");
  });
});
