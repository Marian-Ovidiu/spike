import type {
  BinanceFeedHealth,
  BinanceSpotFeed,
  NormalizedSpotBook,
  PaperBinanceFeed,
} from "../../adapters/binanceSpotFeed.js";
import type {
  BinaryOutcomePrices,
  MarketDataFeed,
  QuoteStaleResult,
} from "../../market/types.js";

/**
 * **Signal-only** adapter for binary mode: wraps Binance BTC spot (live or paper).
 *
 * Feeds the rolling price buffer and all spike / movement math. It must **not** be
 * confused with the binary execution venue (YES/NO quotes) — that is a separate
 * {@link MarketDataFeed} on {@link BotContext.executionFeed}.
 *
 * Implements {@link MarketDataFeed} only so the bot loop can poll one interface;
 * {@link getBinaryOutcomePrices} is always `null` here (outcomes come from the venue feed).
 */
export class BinaryBtcSpotSignalFeed implements MarketDataFeed {
  private readonly inner: BinanceSpotFeed | PaperBinanceFeed;

  constructor(inner: BinanceSpotFeed | PaperBinanceFeed) {
    this.inner = inner;
  }

  /** Underlying pair symbol (e.g. `BTCUSDT`) — signal layer, not the Polymarket slug. */
  getSymbol(): string {
    return this.inner.getSymbol();
  }

  getNormalizedBook(): NormalizedSpotBook | null {
    return this.inner.getNormalizedBook();
  }

  getBinaryOutcomePrices(): BinaryOutcomePrices | null {
    return null;
  }

  getLastMessageAgeMs(now?: number): number {
    return this.inner.getLastMessageAgeMs(now);
  }

  getQuoteStale(now?: number): QuoteStaleResult {
    return this.inner.getQuoteStale(now);
  }

  getHealth(): BinanceFeedHealth {
    return this.inner.getHealth();
  }

  bootstrapRest(): Promise<boolean> {
    return this.inner.bootstrapRest();
  }

  start(): void {
    this.inner.start();
  }

  stop(): void {
    this.inner.stop();
  }
}
