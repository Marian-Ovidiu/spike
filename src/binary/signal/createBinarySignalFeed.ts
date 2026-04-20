import { BinanceSpotFeed, PaperBinanceFeed } from "../../adapters/binanceSpotFeed.js";
import type { BinarySignalSource, MarketDataFeed } from "../../market/types.js";
import { BinaryBtcSpotSignalFeed } from "./binaryBtcSpotSignalFeed.js";

export type CreateBinarySignalFeedOptions = {
  /** When true, use {@link PaperBinanceFeed} instead of live WebSocket for BTC signal. */
  paper?: boolean;
  /** Rolling-buffer / spike signal source (currently only `binance_spot`). */
  binarySignalSource?: BinarySignalSource;
  /** e.g. `BTCUSDT` — Binance spot pair when source is `binance_spot`. */
  binarySignalSymbol?: string;
};

/**
 * BTC spot feed used for spike detection and rolling buffer in {@link MarketMode} `"binary"`,
 * independent of the binary execution venue.
 */
export function createBinarySignalDataFeed(
  options?: CreateBinarySignalFeedOptions
): MarketDataFeed {
  const paper = options?.paper === true;
  const source: BinarySignalSource = options?.binarySignalSource ?? "binance_spot";
  const sym = (options?.binarySignalSymbol ?? "BTCUSDT").trim().toUpperCase();
  if (source !== "binance_spot") {
    console.warn(
      `[createBinarySignalFeed] Unsupported BINARY_SIGNAL_SOURCE="${String(source)}"; using binance_spot`
    );
  }
  const inner = paper
    ? new PaperBinanceFeed({ symbol: sym })
    : new BinanceSpotFeed({ symbol: sym });
  return new BinaryBtcSpotSignalFeed(inner);
}
