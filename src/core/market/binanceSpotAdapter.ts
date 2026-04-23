/**
 * Bridges {@link BinanceSpotFeed} / {@link PaperBinanceFeed} to `src/core/market` contracts
 * and `src/core/domain` book types — no changes to legacy adapter code.
 */
import type { QuoteStaleResult } from "../../market/types.js";
import {
  BinanceSpotFeed,
  PaperBinanceFeed,
  type NormalizedSpotBook,
} from "../../adapters/binanceSpotFeed.js";
import type { InstrumentId } from "../domain/instrument.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { MarketTick } from "../domain/marketTick.js";
import type { FeedStaleness } from "./staleness.js";
import type { MarketSnapshot } from "./snapshot.js";
import type { MarketDataFeed, SpotDualFeed } from "./contracts.js";
import { binanceSpotInstrumentId } from "./instrumentRef.js";

export type BinanceSpotAdapterOptions = {
  /** Exchange pair, e.g. BTCUSDT */
  symbol?: string;
  /** Override default `binance:spot:SYMBOL` id */
  instrumentId?: InstrumentId;
};

export function normalizedSpotBookToTopOfBookL1(
  book: NormalizedSpotBook
): TopOfBookL1 {
  return {
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    midPrice: book.midPrice,
    spreadBps: book.spreadBps,
    bestBidSize: book.bestBidQty,
    bestAskSize: book.bestAskQty,
  };
}

function mapStale(q: QuoteStaleResult): FeedStaleness {
  return { stale: q.stale, reason: q.reason };
}

/** WebSocket spot feed as core {@link SpotDualFeed}. */
export class BinanceSpotCoreFeed implements SpotDualFeed {
  private readonly inner: BinanceSpotFeed;
  readonly instrumentId: InstrumentId;

  constructor(options?: BinanceSpotAdapterOptions) {
    this.inner = new BinanceSpotFeed(
      options?.symbol !== undefined ? { symbol: options.symbol } : {}
    );
    this.instrumentId =
      options?.instrumentId ?? binanceSpotInstrumentId(this.inner.getSymbol());
  }

  /** Escape hatch for legacy tests / diagnostics. */
  getLegacySpotFeed(): BinanceSpotFeed {
    return this.inner;
  }

  getSignalMid(): number | null {
    const b = this.inner.getNormalizedBook();
    return b !== null ? b.midPrice : null;
  }

  getTopOfBookL1(): TopOfBookL1 | null {
    const b = this.inner.getNormalizedBook();
    return b !== null ? normalizedSpotBookToTopOfBookL1(b) : null;
  }

  getLastMessageAgeMs(nowMs?: number): number {
    return this.inner.getLastMessageAgeMs(nowMs);
  }

  getStaleness(nowMs?: number): FeedStaleness {
    return mapStale(this.inner.getQuoteStale(nowMs));
  }

  getMarketSnapshot(nowMs = Date.now()): MarketSnapshot | null {
    const bookRaw = this.inner.getNormalizedBook();
    const staleness = mapStale(this.inner.getQuoteStale(nowMs));
    if (!bookRaw) {
      return {
        instrumentId: this.instrumentId,
        observedAtMs: nowMs,
        signalMid: null,
        lastTradePrice: null,
        book: null,
        staleness,
      };
    }
    return {
      instrumentId: this.instrumentId,
      observedAtMs: bookRaw.observedAtMs,
      signalMid: bookRaw.midPrice,
      lastTradePrice: bookRaw.lastTradePrice,
      book: normalizedSpotBookToTopOfBookL1(bookRaw),
      staleness,
    };
  }

  getMarketTick(nowMs = Date.now()): MarketTick | null {
    void nowMs;
    const bookRaw = this.inner.getNormalizedBook();
    if (!bookRaw) return null;
    const base: MarketTick = {
      observedAtMs: bookRaw.observedAtMs,
      instrumentId: this.instrumentId,
      book: normalizedSpotBookToTopOfBookL1(bookRaw),
    };
    if (
      bookRaw.lastTradePrice !== null &&
      Number.isFinite(bookRaw.lastTradePrice)
    ) {
      return { ...base, lastPrice: bookRaw.lastTradePrice };
    }
    return base;
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

/** Paper spot feed with synthetic L1 (same core ports). */
export class BinanceSpotPaperCoreFeed implements SpotDualFeed {
  private readonly inner: PaperBinanceFeed;
  readonly instrumentId: InstrumentId;

  constructor(options?: BinanceSpotAdapterOptions & { mid?: number; spreadBps?: number }) {
    const paperOpts: {
      symbol?: string;
      mid?: number;
      spreadBps?: number;
    } = {};
    if (options?.symbol !== undefined) paperOpts.symbol = options.symbol;
    if (options?.mid !== undefined) paperOpts.mid = options.mid;
    if (options?.spreadBps !== undefined) paperOpts.spreadBps = options.spreadBps;
    this.inner = new PaperBinanceFeed(paperOpts);
    this.instrumentId =
      options?.instrumentId ?? binanceSpotInstrumentId(this.inner.getSymbol());
  }

  getLegacyPaperFeed(): PaperBinanceFeed {
    return this.inner;
  }

  getSignalMid(): number | null {
    const b = this.inner.getNormalizedBook();
    return b !== null ? b.midPrice : null;
  }

  getTopOfBookL1(): TopOfBookL1 | null {
    const b = this.inner.getNormalizedBook();
    return b !== null ? normalizedSpotBookToTopOfBookL1(b) : null;
  }

  getLastMessageAgeMs(nowMs?: number): number {
    return this.inner.getLastMessageAgeMs(nowMs);
  }

  getStaleness(nowMs?: number): FeedStaleness {
    return mapStale(this.inner.getQuoteStale(nowMs));
  }

  getMarketSnapshot(nowMs = Date.now()): MarketSnapshot | null {
    const bookRaw = this.inner.getNormalizedBook();
    const staleness = mapStale(this.inner.getQuoteStale(nowMs));
    if (!bookRaw) {
      return {
        instrumentId: this.instrumentId,
        observedAtMs: nowMs,
        signalMid: null,
        lastTradePrice: null,
        book: null,
        staleness,
      };
    }
    return {
      instrumentId: this.instrumentId,
      observedAtMs: bookRaw.observedAtMs,
      signalMid: bookRaw.midPrice,
      lastTradePrice: bookRaw.lastTradePrice,
      book: normalizedSpotBookToTopOfBookL1(bookRaw),
      staleness,
    };
  }

  getMarketTick(nowMs = Date.now()): MarketTick | null {
    void nowMs;
    const bookRaw = this.inner.getNormalizedBook();
    if (!bookRaw) return null;
    const base: MarketTick = {
      observedAtMs: bookRaw.observedAtMs,
      instrumentId: this.instrumentId,
      book: normalizedSpotBookToTopOfBookL1(bookRaw),
    };
    if (
      bookRaw.lastTradePrice !== null &&
      Number.isFinite(bookRaw.lastTradePrice)
    ) {
      return { ...base, lastPrice: bookRaw.lastTradePrice };
    }
    return base;
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

export function createBinanceSpotCoreFeed(
  options?: BinanceSpotAdapterOptions & {
    paper?: boolean;
    mid?: number;
    spreadBps?: number;
  }
): SpotDualFeed {
  if (options?.paper === true) {
    return new BinanceSpotPaperCoreFeed(options);
  }
  return new BinanceSpotCoreFeed(options);
}
