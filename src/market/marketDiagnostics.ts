import { BinaryMarketFeed } from "../binary/venue/binaryMarketFeed.js";
import { BinarySyntheticFeed } from "../binary/venue/binarySyntheticFeed.js";
import type { BinanceSpotFeed, PaperBinanceFeed } from "../adapters/binanceSpotFeed.js";
import type {
  BinarySignalSource,
  MarketDataFeed,
  MarketFeedDiagnostics,
  MarketMode,
} from "./types.js";

export function isBinaryMarketFeed(f: MarketDataFeed): f is BinaryMarketFeed {
  return f instanceof BinaryMarketFeed;
}

export function isBinarySyntheticFeed(f: MarketDataFeed): f is BinarySyntheticFeed {
  return f instanceof BinarySyntheticFeed;
}

export function buildMarketFeedShutdownDiagnostics(
  marketMode: MarketMode,
  feed: MarketDataFeed
): MarketFeedDiagnostics {
  if (marketMode === "binary" && isBinaryMarketFeed(feed)) {
    const stale = feed.getQuoteStale();
    return {
      mode: "binary",
      source: "polymarket_gamma",
      symbol: feed.getSymbol(),
      gammaBaseUrl: feed.getGammaBaseUrl(),
      pollCount: feed.getPollCount(),
      httpAttempts: feed.getHttpAttemptCount(),
      maxQuoteAgeMs: feed.getMaxQuoteAgeMs(),
      maxPollSilenceMs: feed.getMaxPollSilenceMs(),
      stale: stale.stale,
      staleReason: stale.reason,
      lastError: feed.getLastError(),
      quote: feed.getNormalizedBinaryQuote(),
    };
  }
  if (marketMode === "binary" && isBinarySyntheticFeed(feed)) {
    return feed.getShutdownDiagnostics();
  }
  const binanceBookFeed = feed as BinanceSpotFeed | PaperBinanceFeed;
  return {
    mode: "spot",
    source: "binance_spot",
    symbol: binanceBookFeed.getSymbol(),
    health: binanceBookFeed.getHealth(),
    lastMessageAgeMs: binanceBookFeed.getLastMessageAgeMs(),
  };
}

export function liveMonitorDataSourceBannerDetail(
  marketMode: MarketMode,
  feed: MarketDataFeed
): string {
  if (marketMode === "binary" && isBinaryMarketFeed(feed)) {
    return `Polymarket Gamma ${feed.getGammaBaseUrl()} | market ${feed.getSymbol()} (poll every ${feed.getPollIntervalMs()}ms)`;
  }
  if (marketMode === "binary" && isBinarySyntheticFeed(feed)) {
    return feed.describeDataSource();
  }
  return liveMonitorBinanceSignalBannerDetail(feed);
}

/** Binance spot feed description (used for binary **signal** path or legacy spot execution). */
export function liveMonitorBinanceSignalBannerDetail(feed: MarketDataFeed): string {
  const sym = feed.getSymbol();
  return `Binance Spot ${sym} (bookTicker + aggTrade WS, REST bootstrap)`;
}

/** Banner line for live monitor when signal and execution feeds differ (binary mode). */
export function liveMonitorDualFeedBannerDetail(
  marketMode: MarketMode,
  signalFeed: MarketDataFeed,
  executionFeed: MarketDataFeed,
  binarySignal?: { source: BinarySignalSource; symbol: string }
): string {
  if (marketMode !== "binary") {
    return liveMonitorDataSourceBannerDetail(marketMode, executionFeed);
  }
  const signal = liveMonitorBinanceSignalBannerDetail(signalFeed);
  const execution = liveMonitorDataSourceBannerDetail("binary", executionFeed);
  const src = binarySignal?.source ?? "binance_spot";
  const sym = binarySignal?.symbol ?? signalFeed.getSymbol();
  return `Underlying (${src} · ${sym}): ${signal}  │  Execution (binary): ${execution}`;
}
