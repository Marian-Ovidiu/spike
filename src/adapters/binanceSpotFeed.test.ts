import { describe, expect, it, vi } from "vitest";

import { PaperBinanceFeed } from "./binanceSpotFeed.js";

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
