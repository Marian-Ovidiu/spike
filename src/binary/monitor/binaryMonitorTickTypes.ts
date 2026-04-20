import type { BinaryOutcomePrices } from "../../market/types.js";

/** When set, {@link formatMonitorTickLine} uses binary-native phrasing (from shared monitor console). */
export type MonitorTickFormatContext = {
  marketMode: "binary";
  /** BTC spot mid driving the rolling buffer / spike logic on this tick. */
  underlyingSignalPrice: number;
  /** True when the Binance signal feed looks stale by WebSocket age. */
  signalFeedPossiblyStale?: boolean;
  binaryOutcomes: BinaryOutcomePrices | null;
  quoteStale: boolean;
  quoteStaleReason: string | null;
  /** Polymarket venue quote age when known. */
  quoteAgeMs: number | null;
};
