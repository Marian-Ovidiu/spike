import type { BinanceFeedHealth, NormalizedSpotBook } from "../adapters/binanceSpotFeed.js";
import type { SyntheticPricingDiagnosticsSummary } from "../binary/venue/syntheticVenueDiagnostics.js";
import type { SyntheticMarketProfileName } from "../binary/venue/syntheticMarketProfile.js";
import type { NormalizedBinaryQuote } from "./binaryQuoteTypes.js";

/** Runtime execution universe: Binance spot order book vs binary outcome prices. */
export type MarketMode = "spot" | "binary";

/**
 * Where {@link MarketMode} `"binary"` reads the rolling-window price series for spikes
 * (independent of the YES/NO execution venue).
 */
export type BinarySignalSource = "binance_spot";

/**
 * Strategy-facing executable top-of-book (spot bid/ask or binary synthetic book).
 * Same numeric shape everywhere so spread filters and paper fills stay reusable.
 */
export type ExecutableTopOfBook = {
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
};

/** YES/NO mid quotes for binary paper execution (null when not applicable, e.g. Binance spot). */
export type BinaryOutcomePrices = { yesPrice: number; noPrice: number };

/** Quote freshness for entry blocking (binary Polymarket vs spot WS). */
export type QuoteStaleResult = {
  stale: boolean;
  reason: string | null;
};

/** Public market-data surface used by {@link BotContext} signal and execution feeds. */
export interface MarketDataFeed {
  getSymbol(): string;
  /** Latest book snapshot; `null` until first valid update. */
  getNormalizedBook(): NormalizedSpotBook | null;
  /**
   * Polymarket-style outcome prices for {@link AppConfig.marketMode} === `"binary"`.
   * Spot feeds return `null`.
   */
  getBinaryOutcomePrices(): BinaryOutcomePrices | null;
  getLastMessageAgeMs(now?: number): number;
  /**
   * Binary: poll / venue quote age. Spot: whether we have seen any WS traffic (`stale` when none yet).
   * Live monitor uses this only when {@link AppConfig.marketMode} is `"binary"`.
   */
  getQuoteStale(now?: number): QuoteStaleResult;
  getHealth(): BinanceFeedHealth;
  bootstrapRest(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function toExecutableTopOfBook(book: NormalizedSpotBook): ExecutableTopOfBook {
  return {
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    midPrice: book.midPrice,
    spreadBps: book.spreadBps,
  };
}

export type MarketFeedDiagnostics =
  | {
      mode: "spot";
      source: "binance_spot";
      symbol: string;
      health: BinanceFeedHealth;
      lastMessageAgeMs: number;
    }
  | {
      mode: "binary";
      source: "synthetic_env";
      symbol: string;
      upPrice: number;
      downPrice: number;
      syntheticSpreadBps: number;
      /** Baseline spread before volatility widening. */
      syntheticBaseSpreadBps?: number;
      syntheticMaxSpreadBps?: number;
      /** Slippage rate (bps) on synthetic aggressive buys when modeled. */
      syntheticSlippageBps?: number;
      maxLiquidityPerTrade?: number;
      lastUpdateAtMs: number;
      /** Set when `SYNTHETIC_MARKET_PROFILE` is configured. */
      syntheticMarketProfile?: SyntheticMarketProfileName | null;
      /** Scales extra spread from fair-move / lag instability EWM (0 = off). */
      widenOnVolatility?: number;
      /** Populated after at least one `applySignalProbability` since last `setOutcomePrices`. */
      syntheticPricingDiagnostics?: SyntheticPricingDiagnosticsSummary | null;
    }
  | {
      mode: "binary";
      source: "polymarket_gamma";
      symbol: string;
      gammaBaseUrl: string;
      pollCount: number;
      httpAttempts: number;
      maxQuoteAgeMs: number;
      maxPollSilenceMs: number;
      stale: boolean;
      staleReason: string | null;
      lastError: string | null;
      quote: NormalizedBinaryQuote | null;
    };
