import type { Instrument, InstrumentId } from "../domain/instrument.js";
import type { VenueSymbol } from "../domain/symbol.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { FeedStaleness } from "./staleness.js";
import type { MarketSnapshot } from "./snapshot.js";
import {
  BinanceSpotCoreFeed,
  BinanceSpotPaperCoreFeed,
  type BinanceSpotAdapterOptions,
} from "./binanceSpotAdapter.js";
import { binanceUsdmPerpInstrumentId } from "./instrumentRef.js";

export type FuturesVenueKind = "perpetual_swap" | "dated_future";

export type FuturesInstrumentType = FuturesVenueKind;

export type FuturesFeedImplementationKind =
  | "futures_native_paper"
  | "spot_proxy"
  | "spot_paper_proxy";

export type FuturesPriceSourceKind =
  | "synthetic_signal_mid"
  | "synthetic_execution_book"
  | "synthetic_mark_price"
  | "synthetic_index_price"
  | "spot_proxy_signal_mid"
  | "spot_proxy_execution_book";

export type FuturesFeedCapabilities = {
  readonly supportsMarkPrice: boolean;
  readonly supportsIndexPrice: boolean;
  readonly supportsTopOfBookOnly: boolean;
  readonly supportsDepth: boolean;
  readonly supportsSequence: boolean;
  readonly supportsStaleness: boolean;
};

export type FuturesPriceSources = {
  readonly signalPrice: FuturesPriceSourceKind;
  readonly executionBook: FuturesPriceSourceKind;
  readonly markPrice: FuturesPriceSourceKind;
  readonly indexPrice: FuturesPriceSourceKind;
};

export type FuturesContractMetadata = Instrument & {
  readonly instrumentType: FuturesInstrumentType;
  readonly settlementAsset: string;
};

export type FuturesMarketTick = {
  readonly observedAtMs: number;
  readonly instrumentId: InstrumentId;
  readonly contract: FuturesContractMetadata;
  readonly book?: TopOfBookL1;
  readonly lastPrice?: number;
  readonly signalMid: number | null;
  readonly markPrice: number | null;
  readonly indexPrice: number | null;
  readonly sequence: number;
  readonly signalPriceSource: FuturesPriceSourceKind;
  readonly executionBookSource: FuturesPriceSourceKind;
  readonly markPriceSource: FuturesPriceSourceKind;
  readonly indexPriceSource: FuturesPriceSourceKind;
};

export type FuturesMarketSnapshot = MarketSnapshot & {
  readonly contract: FuturesContractMetadata;
  readonly markPrice: number | null;
  readonly indexPrice: number | null;
  readonly sequence: number;
  readonly venueKind: FuturesVenueKind;
  readonly implementationKind: FuturesFeedImplementationKind;
  readonly signalPriceSource: FuturesPriceSourceKind;
  readonly executionBookSource: FuturesPriceSourceKind;
  readonly markPriceSource: FuturesPriceSourceKind;
  readonly indexPriceSource: FuturesPriceSourceKind;
  readonly capabilities: FuturesFeedCapabilities;
};

export type FuturesFeedConfig = {
  readonly symbol?: string;
  readonly instrumentId?: InstrumentId;
  readonly contract?: Partial<Instrument>;
  readonly venueKind?: FuturesVenueKind;
  readonly initialSignalMid?: number;
  readonly initialMarkPrice?: number;
  readonly initialIndexPrice?: number;
  readonly initialSpreadBps?: number;
  readonly syntheticUpdateMs?: number;
  readonly oscillationBps?: number;
  readonly markBasisBps?: number;
  readonly indexBasisBps?: number;
  readonly fundingBiasBps?: number;
};

/**
 * Futures-oriented market boundary.
 *
 * This is the contract the futures runtime now depends on. It carries futures
 * contract metadata, mark/index prices, top of book, and sequencing / freshness.
 */
export interface FuturesMarketFeed {
  readonly instrumentId: InstrumentId;
  readonly contract: FuturesContractMetadata;
  readonly venueKind: FuturesVenueKind;
  readonly implementationKind: FuturesFeedImplementationKind;
  readonly capabilities: FuturesFeedCapabilities;
  readonly priceSources: FuturesPriceSources;

  getSignalMid(): number | null;
  getMarkPrice(): number | null;
  getIndexPrice(): number | null;
  getExecutionBook(): TopOfBookL1 | null;
  getTopOfBookL1(): TopOfBookL1 | null;
  getLastMessageAgeMs(nowMs?: number): number;
  getStaleness(nowMs?: number): FeedStaleness;
  getSequence(): number;
  getMarketSnapshot(nowMs?: number): FuturesMarketSnapshot | null;
  getMarketTick(nowMs?: number): FuturesMarketTick | null;
  bootstrapRest(): Promise<boolean>;
  start(): void;
  stop(): void;
}

function baseAssetFromSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const suffixes = ["USDT", "USD", "BUSD", "USDC", "FDUSD"];
  for (const suffix of suffixes) {
    if (s.endsWith(suffix) && s.length > suffix.length) {
      return s.slice(0, -suffix.length);
    }
  }
  return s;
}

function defaultContract(input: FuturesFeedConfig): FuturesContractMetadata {
  const symbol = (input.symbol ?? "BTCUSDT").trim().toUpperCase();
  const instrumentId =
    input.instrumentId ?? binanceUsdmPerpInstrumentId(symbol);
  return {
    id: instrumentId,
    venueSymbol: {
      venue: input.venueKind === "dated_future"
        ? "binance_usdm_dated_paper"
        : "binance_usdm_perp_paper",
      code: symbol,
    },
    kind: input.venueKind ?? "perpetual_swap",
    instrumentType: input.venueKind ?? "perpetual_swap",
    baseAsset: baseAssetFromSymbol(symbol),
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    tickSize: input.contract?.tickSize ?? 0.1,
    lotSize: input.contract?.lotSize ?? 0.001,
    minQuantity: input.contract?.minQuantity ?? input.contract?.lotSize ?? 0.001,
    contractMultiplier: input.contract?.contractMultiplier ?? 1,
  };
}

function clampPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function alignUp(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.ceil(value / step - 1e-12) * step;
}

function alignDown(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.floor(value / step + 1e-12) * step;
}

function isExecutableBook(book: TopOfBookL1 | null): book is TopOfBookL1 {
  if (!book) return false;
  return (
    Number.isFinite(book.bestBid) &&
    Number.isFinite(book.bestAsk) &&
    Number.isFinite(book.midPrice) &&
    Number.isFinite(book.spreadBps) &&
    book.bestBid > 0 &&
    book.bestAsk >= book.bestBid
  );
}

class PaperFuturesMarketFeed implements FuturesMarketFeed {
  readonly contract: FuturesContractMetadata;
  readonly instrumentId: InstrumentId;
  readonly venueKind: FuturesVenueKind;
  readonly implementationKind: FuturesFeedImplementationKind =
    "futures_native_paper";
  readonly capabilities: FuturesFeedCapabilities = {
    supportsMarkPrice: true,
    supportsIndexPrice: true,
    supportsTopOfBookOnly: true,
    supportsDepth: false,
    supportsSequence: true,
    supportsStaleness: true,
  };
  readonly priceSources: FuturesPriceSources = {
    signalPrice: "synthetic_signal_mid",
    executionBook: "synthetic_execution_book",
    markPrice: "synthetic_mark_price",
    indexPrice: "synthetic_index_price",
  };

  private readonly syntheticUpdateMs: number;
  private readonly initialSignalMid: number;
  private readonly initialMarkPrice: number;
  private readonly initialIndexPrice: number;
  private readonly initialSpreadBps: number;
  private readonly oscillationBps: number;
  private readonly markBasisBps: number;
  private readonly indexBasisBps: number;
  private readonly fundingBiasBps: number;

  private started = false;
  private startedAtMs = 0;
  private lastMessageAtMs = 0;
  private sequence = 0;
  private signalMid: number;
  private markPrice: number;
  private indexPrice: number;
  private book: TopOfBookL1;

  constructor(config: FuturesFeedConfig = {}) {
    this.contract = defaultContract(config);
    this.instrumentId = this.contract.id;
    this.venueKind = config.venueKind ?? "perpetual_swap";
    this.syntheticUpdateMs = clampPositive(config.syntheticUpdateMs ?? 2_000, 2_000);
    this.initialSignalMid = clampPositive(config.initialSignalMid ?? 95_000, 95_000);
    this.initialMarkPrice = clampPositive(
      config.initialMarkPrice ?? this.initialSignalMid,
      this.initialSignalMid
    );
    this.initialIndexPrice = clampPositive(
      config.initialIndexPrice ?? this.initialSignalMid * 0.9995,
      this.initialSignalMid
    );
    this.initialSpreadBps = Math.max(0.5, config.initialSpreadBps ?? 2);
    this.oscillationBps = Math.max(0, config.oscillationBps ?? 18);
    this.markBasisBps = config.markBasisBps ?? 0.8;
    this.indexBasisBps = config.indexBasisBps ?? -0.2;
    this.fundingBiasBps = config.fundingBiasBps ?? 0.05;

    this.signalMid = this.initialSignalMid;
    this.markPrice = this.initialMarkPrice;
    this.indexPrice = this.initialIndexPrice;
    this.book = this.buildBook(this.signalMid, this.initialSpreadBps);
  }

  bootstrapRest(): Promise<boolean> {
    this.started = true;
    this.startedAtMs = Date.now();
    this.lastMessageAtMs = this.startedAtMs;
    this.sequence = 1;
    this.signalMid = this.initialSignalMid;
    this.indexPrice = this.initialIndexPrice;
    this.markPrice = this.initialMarkPrice;
    this.book = this.buildBook(this.signalMid, this.initialSpreadBps);
    return Promise.resolve(true);
  }

  start(): void {
    this.started = true;
    if (this.startedAtMs === 0) {
      this.startedAtMs = Date.now();
      this.lastMessageAtMs = this.startedAtMs;
    }
  }

  stop(): void {
    this.started = false;
  }

  getSignalMid(): number | null {
    this.refresh(Date.now());
    return this.signalMid;
  }

  getMarkPrice(): number | null {
    this.refresh(Date.now());
    return this.markPrice;
  }

  getIndexPrice(): number | null {
    this.refresh(Date.now());
    return this.indexPrice;
  }

  getExecutionBook(): TopOfBookL1 | null {
    this.refresh(Date.now());
    return this.book;
  }

  getTopOfBookL1(): TopOfBookL1 | null {
    return this.getExecutionBook();
  }

  getLastMessageAgeMs(nowMs = Date.now()): number {
    this.refresh(nowMs);
    return Math.max(0, nowMs - this.lastMessageAtMs);
  }

  getStaleness(nowMs = Date.now()): FeedStaleness {
    const age = this.getLastMessageAgeMs(nowMs);
    return {
      stale: age > this.syntheticUpdateMs * 2,
      reason: age > this.syntheticUpdateMs * 2 ? "synthetic_quote_age" : null,
    };
  }

  getSequence(): number {
    this.refresh(Date.now());
    return this.sequence;
  }

  getMarketSnapshot(nowMs = Date.now()): FuturesMarketSnapshot | null {
    this.refresh(nowMs);
    if (!isExecutableBook(this.book)) return null;
    return {
      contract: this.contract,
      instrumentId: this.instrumentId,
      observedAtMs: nowMs,
      signalMid: this.signalMid,
      lastTradePrice: null,
      book: this.book,
      staleness: this.getStaleness(nowMs),
      markPrice: this.markPrice,
      indexPrice: this.indexPrice,
      sequence: this.sequence,
      venueKind: this.venueKind,
      implementationKind: this.implementationKind,
      signalPriceSource: this.priceSources.signalPrice,
      executionBookSource: this.priceSources.executionBook,
      markPriceSource: this.priceSources.markPrice,
      indexPriceSource: this.priceSources.indexPrice,
      capabilities: this.capabilities,
    };
  }

  getMarketTick(nowMs = Date.now()): FuturesMarketTick | null {
    this.refresh(nowMs);
    if (!isExecutableBook(this.book)) return null;
    return {
      contract: this.contract,
      observedAtMs: nowMs,
      instrumentId: this.instrumentId,
      book: this.book,
      signalMid: this.signalMid,
      markPrice: this.markPrice,
      indexPrice: this.indexPrice,
      sequence: this.sequence,
      signalPriceSource: this.priceSources.signalPrice,
      executionBookSource: this.priceSources.executionBook,
      markPriceSource: this.priceSources.markPrice,
      indexPriceSource: this.priceSources.indexPrice,
    };
  }

  private refresh(nowMs: number): void {
    if (!this.started) return;
    if (this.lastMessageAtMs === 0) {
      this.lastMessageAtMs = nowMs;
      return;
    }

    const elapsed = Math.max(0, nowMs - this.lastMessageAtMs);
    const steps = Math.floor(elapsed / this.syntheticUpdateMs);
    if (steps <= 0) return;

    this.lastMessageAtMs += steps * this.syntheticUpdateMs;
    this.sequence += steps;

    const seq = this.sequence;
    const oscillation =
      Math.sin(seq / 5) * this.oscillationBps +
      Math.sin(seq / 17) * (this.oscillationBps * 0.35);
    const drift = seq * 0.02;
    const signalBps = oscillation + drift;
    const indexBps = signalBps * 0.85 + this.indexBasisBps;
    const markBps = indexBps + this.markBasisBps + this.fundingBiasBps;
    const spreadBps = Math.max(
      this.initialSpreadBps,
      this.initialSpreadBps + Math.abs(oscillation) * 0.05 + Math.min(12, seq * 0.01)
    );

    this.signalMid = this.initialSignalMid * (1 + signalBps / 10_000);
    this.indexPrice = this.initialSignalMid * (1 + indexBps / 10_000);
    this.markPrice = this.initialSignalMid * (1 + markBps / 10_000);
    this.book = this.buildBook(this.signalMid, spreadBps);
  }

  private buildBook(mid: number, spreadBps: number): TopOfBookL1 {
    const half = (mid * spreadBps) / 10_000 / 2;
    const bestBid = Math.max(
      this.contract.tickSize,
      alignDown(mid - half, this.contract.tickSize)
    );
    const bestAsk = Math.max(
      bestBid + this.contract.tickSize,
      alignUp(mid + half, this.contract.tickSize)
    );
    return {
      bestBid,
      bestAsk,
      midPrice: mid,
      spreadBps,
      bestBidSize: Math.max(this.contract.minQuantity ?? this.contract.lotSize, this.contract.lotSize),
      bestAskSize: Math.max(this.contract.minQuantity ?? this.contract.lotSize, this.contract.lotSize),
    };
  }
}

class SpotProxyFuturesMarketFeed implements FuturesMarketFeed {
  private readonly inner: BinanceSpotCoreFeed | BinanceSpotPaperCoreFeed;
  readonly instrumentId: InstrumentId;
  readonly contract: FuturesContractMetadata;
  readonly venueKind: FuturesVenueKind = "perpetual_swap";
  readonly implementationKind: FuturesFeedImplementationKind;
  readonly capabilities: FuturesFeedCapabilities = {
    supportsMarkPrice: false,
    supportsIndexPrice: false,
    supportsTopOfBookOnly: true,
    supportsDepth: false,
    supportsSequence: false,
    supportsStaleness: true,
  };
  readonly priceSources: FuturesPriceSources = {
    signalPrice: "spot_proxy_signal_mid",
    executionBook: "spot_proxy_execution_book",
    markPrice: "spot_proxy_signal_mid",
    indexPrice: "spot_proxy_signal_mid",
  };

  constructor(
    options?: BinanceSpotAdapterOptions & {
      paper?: boolean;
      mid?: number;
      spreadBps?: number;
    }
  ) {
    const spotOptions: BinanceSpotAdapterOptions =
      options?.symbol !== undefined || options?.instrumentId !== undefined
        ? {
            ...(options?.symbol !== undefined ? { symbol: options.symbol } : {}),
            ...(options?.instrumentId !== undefined
              ? { instrumentId: options.instrumentId }
              : {}),
          }
        : {};

    if (options?.paper === true) {
      this.inner = new BinanceSpotPaperCoreFeed({
        ...spotOptions,
        ...(options?.mid !== undefined ? { mid: options.mid } : {}),
        ...(options?.spreadBps !== undefined
          ? { spreadBps: options.spreadBps }
          : {}),
      });
      this.implementationKind = "spot_paper_proxy";
    } else {
      this.inner = new BinanceSpotCoreFeed(spotOptions);
      this.implementationKind = "spot_proxy";
    }
    this.instrumentId = this.inner.instrumentId;
    const symbolAccessor = this.inner as unknown as { getSymbol(): string };
    const symbol = symbolAccessor.getSymbol();
    this.contract = {
      id: this.instrumentId,
      venueSymbol: {
        venue: "binance_spot_proxy",
        code: symbol,
      } satisfies VenueSymbol,
      kind: "perpetual_swap",
      instrumentType: "perpetual_swap",
      baseAsset: baseAssetFromSymbol(symbol),
      quoteAsset: "USDT",
      settlementAsset: "USDT",
      tickSize: 0.01,
      lotSize: 0.0001,
      minQuantity: 0.0001,
      contractMultiplier: 1,
    };
  }

  getSignalMid(): number | null {
    return this.inner.getSignalMid();
  }

  getMarkPrice(): number | null {
    return this.inner.getSignalMid();
  }

  getIndexPrice(): number | null {
    return this.inner.getSignalMid();
  }

  getExecutionBook(): TopOfBookL1 | null {
    return this.inner.getTopOfBookL1();
  }

  getTopOfBookL1(): TopOfBookL1 | null {
    return this.inner.getTopOfBookL1();
  }

  getLastMessageAgeMs(nowMs?: number): number {
    return this.inner.getLastMessageAgeMs(nowMs);
  }

  getStaleness(nowMs?: number): FeedStaleness {
    return this.inner.getStaleness(nowMs);
  }

  getSequence(): number {
    return 0;
  }

  getMarketSnapshot(nowMs = Date.now()): FuturesMarketSnapshot | null {
    const snap = this.inner.getMarketSnapshot(nowMs);
    if (!snap) return null;
    return {
      ...snap,
      contract: this.contract,
      markPrice: snap.signalMid,
      indexPrice: snap.signalMid,
      sequence: this.getSequence(),
      venueKind: this.venueKind,
      implementationKind: this.implementationKind,
      signalPriceSource: this.priceSources.signalPrice,
      executionBookSource: this.priceSources.executionBook,
      markPriceSource: this.priceSources.markPrice,
      indexPriceSource: this.priceSources.indexPrice,
      capabilities: this.capabilities,
    };
  }

  getMarketTick(nowMs = Date.now()): FuturesMarketTick | null {
    const tick = this.inner.getMarketTick?.(nowMs);
    if (!tick) return null;
    return {
      ...tick,
      contract: this.contract,
      signalMid: tick.book?.midPrice ?? tick.lastPrice ?? null,
      markPrice: tick.book?.midPrice ?? tick.lastPrice ?? null,
      indexPrice: tick.book?.midPrice ?? tick.lastPrice ?? null,
      sequence: this.getSequence(),
      signalPriceSource: this.priceSources.signalPrice,
      executionBookSource: this.priceSources.executionBook,
      markPriceSource: this.priceSources.markPrice,
      indexPriceSource: this.priceSources.indexPrice,
    };
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

export function createFuturesPaperMarketFeed(
  config?: FuturesFeedConfig
): FuturesMarketFeed {
  return new PaperFuturesMarketFeed(config);
}

export function createCompatSpotProxyFuturesFeed(
  options?: BinanceSpotAdapterOptions & {
    paper?: boolean;
    mid?: number;
    spreadBps?: number;
  }
): FuturesMarketFeed {
  const spotOptions: BinanceSpotAdapterOptions = {};
  if (options?.symbol !== undefined) {
    spotOptions.symbol = options.symbol;
  }
  if (options?.instrumentId !== undefined) {
    spotOptions.instrumentId = options.instrumentId;
  }
  return new SpotProxyFuturesMarketFeed({
    ...spotOptions,
    ...(options?.paper !== undefined ? { paper: options.paper } : {}),
    ...(options?.mid !== undefined ? { mid: options.mid } : {}),
    ...(options?.spreadBps !== undefined ? { spreadBps: options.spreadBps } : {}),
  });
}

export function createDefaultFuturesMarketFeed(
  options?: FuturesFeedConfig & {
    spotProxyFallback?: boolean;
  }
): FuturesMarketFeed {
  if (options?.spotProxyFallback === true) {
    const spotOptions: BinanceSpotAdapterOptions = {};
    if (options.symbol !== undefined) {
      spotOptions.symbol = options.symbol;
    }
    if (options.instrumentId !== undefined) {
      spotOptions.instrumentId = options.instrumentId;
    }
    const proxyOptions: BinanceSpotAdapterOptions & {
      paper: boolean;
      mid?: number;
      spreadBps?: number;
    } = {
      ...spotOptions,
      paper: true,
      ...(options.initialSignalMid !== undefined
        ? { mid: options.initialSignalMid }
        : {}),
      ...(options.initialSpreadBps !== undefined
        ? { spreadBps: options.initialSpreadBps }
        : {}),
    };
    return createCompatSpotProxyFuturesFeed(proxyOptions);
  }
  return createFuturesPaperMarketFeed(options);
}

/**
 * Backward-compatible alias for older call sites. Default is now futures-native paper,
 * not spot-based.
 */
export function createTemporaryFuturesMarketFeed(
  options?: FuturesFeedConfig & {
    spotProxyFallback?: boolean;
  }
): FuturesMarketFeed {
  return createDefaultFuturesMarketFeed(options);
}
