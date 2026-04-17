import { describe, expect, it, vi } from "vitest";

import { BinanceSpotFeed, PaperBinanceFeed } from "./binanceSpotFeed.js";

describe("PaperBinanceFeed", () => {
  it("builds a normalized book with consistent mid, spreadAbs, and spreadBps", () => {
    const feed = new PaperBinanceFeed({
      symbol: "BTCUSDT",
      mid: 100_000,
      spreadBps: 10,
    });
    const book = feed.getNormalizedBook();
    expect(book).not.toBeNull();
    expect(book!.symbol).toBe("BTCUSDT");
    expect(book!.midPrice).toBe(100_000);
    expect(book!.bestAsk - book!.bestBid).toBeCloseTo(book!.spreadAbs, 8);
    expect(book!.spreadBps).toBeCloseTo(10, 5);
  });

  it("reports increasing last-message age until the feed is touched", () => {
    vi.useFakeTimers();
    const feed = new PaperBinanceFeed({ mid: 50_000, spreadBps: 2 });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    feed.setMid(50_100);
    expect(feed.getLastMessageAgeMs(t0)).toBe(0);
    vi.setSystemTime(t0 + 5000);
    expect(feed.getLastMessageAgeMs()).toBe(5000);
    vi.useRealTimers();
  });
});

describe("BinanceSpotFeed bookTicker", () => {
  it("applies official bookTicker fields b/a (no event type e on stream)", () => {
    const feed = new BinanceSpotFeed({ symbol: "BTCUSDT" });
    feed._applyBookTickerPayloadForTest({
      u: 400_900_217,
      s: "BTCUSDT",
      b: "65000.10",
      B: "1.5",
      a: "65000.20",
      A: "2.0",
    });
    const book = feed.getNormalizedBook();
    expect(book).not.toBeNull();
    expect(book!.bestBid).toBeCloseTo(65000.1, 8);
    expect(book!.bestAsk).toBeCloseTo(65000.2, 8);
    expect(book!.midPrice).toBeCloseTo(65000.15, 8);
  });

  it("updates mid when subsequent bookTicker prices move", () => {
    const feed = new BinanceSpotFeed({ symbol: "BTCUSDT" });
    feed._applyBookTickerPayloadForTest({
      s: "BTCUSDT",
      b: "100",
      B: "1",
      a: "101",
      A: "1",
    });
    const m1 = feed.getNormalizedBook()!.midPrice;
    feed._applyBookTickerPayloadForTest({
      s: "BTCUSDT",
      b: "100.5",
      B: "1",
      a: "101.5",
      A: "1",
    });
    const m2 = feed.getNormalizedBook()!.midPrice;
    expect(m2 - m1).toBeCloseTo(0.5, 8);
  });
});
