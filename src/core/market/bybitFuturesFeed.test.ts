import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFuturesMarketFeed,
  resolveFuturesExchangeFromEnv,
} from "./futuresFeed.js";
import {
  parseBybitFuturesOrderbookMessage,
  parseBybitFuturesTickerMessage,
  parseBybitFuturesTradeMessage,
} from "./bybitFuturesFeed.js";

describe("Bybit futures feed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the exchange from env", () => {
    vi.stubEnv("FUTURES_EXCHANGE", "bybit");
    expect(resolveFuturesExchangeFromEnv()).toBe("bybit");
  });

  it("selects the Bybit feed when FUTURES_EXCHANGE=bybit", () => {
    vi.stubEnv("FUTURES_EXCHANGE", "bybit");
    vi.stubEnv("BYBIT_SYMBOL", "BTCUSDT");
    const feed = createDefaultFuturesMarketFeed({ symbol: "BTCUSDT" });
    expect(feed.implementationKind).toBe("bybit_public_ws");
    expect(feed.contract.venueSymbol.venue).toBe("bybit_usdm_perp");
  });

  it("parses a Bybit orderbook snapshot into a top-of-book", () => {
    const book = parseBybitFuturesOrderbookMessage({
      topic: "orderbook.1.BTCUSDT",
      type: "snapshot",
      ts: 1,
      data: {
        s: "BTCUSDT",
        b: [["65000.00", "1.5"]],
        a: [["65000.10", "2.0"]],
        u: 123,
        seq: 456,
      },
    });
    expect(book?.bestBid).toBeCloseTo(65000, 8);
    expect(book?.bestAsk).toBeCloseTo(65000.1, 8);
    expect(book?.midPrice).toBeCloseTo(65000.05, 8);
    expect(book?.bestBidSize).toBeCloseTo(1.5, 8);
    expect(book?.bestAskSize).toBeCloseTo(2.0, 8);
  });

  it("parses ticker snapshots and trade messages", () => {
    const ticker = parseBybitFuturesTickerMessage({
      topic: "tickers.BTCUSDT",
      type: "snapshot",
      ts: 1,
      data: {
        symbol: "BTCUSDT",
        lastPrice: "65001.2",
        markPrice: "65000.9",
        indexPrice: "64990.1",
        bid1Price: "65001.1",
        bid1Size: "3.2",
        ask1Price: "65001.3",
        ask1Size: "4.1",
        cs: 11,
      },
    });
    expect(ticker.lastPrice).toBeCloseTo(65001.2, 8);
    expect(ticker.markPrice).toBeCloseTo(65000.9, 8);
    expect(ticker.indexPrice).toBeCloseTo(64990.1, 8);

    const trade = parseBybitFuturesTradeMessage({
      topic: "publicTrade.BTCUSDT",
      type: "snapshot",
      ts: 1,
      data: [
        { T: 1, s: "BTCUSDT", S: "Buy", v: "0.1", p: "65002.1", L: "PlusTick" },
      ],
    });
    expect(trade).toBeCloseTo(65002.1, 8);
  });
});
