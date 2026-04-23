/**
 * Neutral market adapter contracts + Binance spot bridge.
 *
 * ## Versus `src/market/types.ts` (legacy)
 *
 * See comment block at bottom of this file after exports.
 */

export type { FeedStaleness } from "./staleness.js";
export type { MarketSnapshot } from "./snapshot.js";
export type {
  TopOfBookProvider,
  MarketDataFeed,
  ExecutionVenueFeed,
  SpotDualFeed,
} from "./contracts.js";
export type {
  FuturesContractMetadata,
  FuturesFeedCapabilities,
  FuturesFeedImplementationKind,
  FuturesMarketFeed,
  FuturesPriceSourceKind,
  FuturesPriceSources,
  FuturesVenueKind,
} from "./futuresFeed.js";

export {
  binanceSpotInstrumentId,
  binanceUsdmPerpInstrumentId,
  parseVenueFromInstrumentId,
} from "./instrumentRef.js";

export type { BinanceSpotAdapterOptions } from "./binanceSpotAdapter.js";
export {
  normalizedSpotBookToTopOfBookL1,
  BinanceSpotCoreFeed,
  BinanceSpotPaperCoreFeed,
  createBinanceSpotCoreFeed,
} from "./binanceSpotAdapter.js";
export {
  createCompatSpotProxyFuturesFeed,
  createDefaultFuturesMarketFeed,
  createFuturesPaperMarketFeed,
  createTemporaryFuturesMarketFeed,
} from "./futuresFeed.js";

export type { CoreVenueAdapterKind, FuturesDualFeedPlaceholder } from "./futuresExtension.js";

/*
 * Legacy `src/market/types.ts` vs `src/core/market`:
 *
 * | Legacy | Core |
 * |--------|------|
 * | `MarketDataFeed` (getBinaryOutcomePrices, getNormalizedBook) | `MarketDataFeed` — no outcome prices; signal via `getSignalMid` / `getMarketSnapshot` |
 * | `ExecutableTopOfBook` | `TopOfBookL1` in `core/domain/book.ts`, produced by `getTopOfBookL1()` |
 * | `QuoteStaleResult` | `FeedStaleness` — same fields, neutral name |
 * | `NormalizedSpotBook` | Mapped by `normalizedSpotBookToTopOfBookL1` + snapshot/tick builders |
 * | Binary / Gamma diagnostics on `MarketFeedDiagnostics` | Not present — add futures-specific diagnostics later |
 *
 * Wire `liveMonitor` / `botLoop` to these types in a follow-up refactor; legacy modules stay unchanged.
 */
