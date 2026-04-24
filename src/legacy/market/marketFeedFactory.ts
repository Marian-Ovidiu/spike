import { BinanceSpotFeed, PaperBinanceFeed } from "../adapters/binanceSpotFeed.js";
import {
  createBinarySignalDataFeed,
  type CreateBinarySignalFeedOptions,
} from "../../binary/signal/createBinarySignalFeed.js";
import { createBinaryExecutionFeed } from "../../binary/venue/createBinaryExecutionFeed.js";
import type { MarketDataFeed, MarketMode } from "./types.js";

let legacySpotMarketModeDeprecationLogged = false;

export type CreateMarketDataFeedOptions = {
  /**
   * When true (e.g. `npm start`), use {@link PaperBinanceFeed} instead of live WebSocket.
   * Binary execution feed ignores this for the venue itself (synthetic or Gamma).
   */
  paper?: boolean;
};

export type CreateSignalDataFeedOptions = CreateMarketDataFeedOptions &
  CreateBinarySignalFeedOptions;

/**
 * Selects the concrete feed for the given {@link MarketMode}.
 * Spot + non-paper → {@link BinanceSpotFeed}; spot + paper → {@link PaperBinanceFeed};
 * binary → {@link createBinaryExecutionFeed}.
 */
export function createMarketDataFeed(
  mode: MarketMode,
  options?: CreateMarketDataFeedOptions
): MarketDataFeed {
  if (mode === "binary") {
    return createBinaryExecutionFeed();
  }
  if (!legacySpotMarketModeDeprecationLogged) {
    legacySpotMarketModeDeprecationLogged = true;
    console.warn(
      "[legacy-spot] MARKET_MODE=spot uses deprecated single-feed Binance execution paper. Prefer MARKET_MODE=binary (Binance remains available as the signal feed)."
    );
  }
  const paper = options?.paper === true;
  return paper ? new PaperBinanceFeed() : new BinanceSpotFeed();
}

/**
 * Price series used for spike detection, rolling buffer, and movement context.
 * In {@link MarketMode} `"binary"` this is always BTC spot (paper or live Binance),
 * independent of the binary execution venue feed.
 */
export function createSignalDataFeed(
  mode: MarketMode,
  options?: CreateSignalDataFeedOptions
): MarketDataFeed {
  if (mode === "binary") {
    return createBinarySignalDataFeed(options);
  }
  return createMarketDataFeed(mode, options);
}

/**
 * Spot: one Binance (or paper) feed instance serves as both signal and execution.
 * Binary: BTC spot signal feed + separate binary execution feed.
 */
export function createSignalAndExecutionFeeds(
  mode: MarketMode,
  options?: CreateSignalDataFeedOptions
): { signalFeed: MarketDataFeed; executionFeed: MarketDataFeed } {
  const executionFeed = createMarketDataFeed(mode, options);
  if (mode === "spot") {
    return { signalFeed: executionFeed, executionFeed };
  }
  return {
    signalFeed: createSignalDataFeed("binary", options),
    executionFeed,
  };
}
