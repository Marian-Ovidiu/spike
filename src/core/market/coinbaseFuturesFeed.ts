import type { InstrumentId } from "../domain/instrument.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { FeedStaleness } from "./staleness.js";
import type {
  FuturesContractMetadata,
  FuturesFeedCapabilities,
  FuturesFeedImplementationKind,
  FuturesMarketFeed,
  FuturesMarketSnapshot,
  FuturesMarketTick,
  FuturesPriceSources,
  FuturesVenueKind,
} from "./futuresFeed.js";
import { readCoinbaseExchangeConfig, readCoinbasePublicConfig } from "../../config/env.js";
import {
  CoinbaseApiError,
  CoinbaseClient,
  type CoinbaseProduct,
  type CoinbaseProductBookResponse,
  type CoinbaseBestBidAskResponse,
} from "../../exchanges/coinbase/coinbaseClient.js";
import { readRuntimeConfig } from "../../config/env.js";

export type CoinbaseFuturesFeedOptions = {
  productId?: string;
  instrumentId?: InstrumentId;
  refreshIntervalMs?: number;
  staleAfterMs?: number;
};

export type CoinbaseFuturesFeedTelemetry = {
  exchange: "coinbase";
  productId: string;
  feed: "coinbase_public";
  trading: "paper";
  bootstrap: "public_or_skipped" | "signed";
  signedEndpoints: boolean;
};

export class CoinbaseFuturesFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoinbaseFuturesFeedError";
  }
}

function normalizeProductId(value: string): string {
  return value.trim().toUpperCase();
}

function parseNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitProductId(productId: string): { baseAsset: string; quoteAsset: string } {
  const normalized = normalizeProductId(productId);
  const dashIndex = normalized.indexOf("-");
  if (dashIndex > 0) {
    const base = normalized.slice(0, dashIndex);
    const quote = normalized.slice(dashIndex + 1).split("-")[0] || "USD";
    return { baseAsset: base, quoteAsset: quote };
  }
  if (normalized.endsWith("USDT")) {
    return { baseAsset: normalized.slice(0, -4), quoteAsset: "USDT" };
  }
  if (normalized.endsWith("USD")) {
    return { baseAsset: normalized.slice(0, -3), quoteAsset: "USD" };
  }
  return { baseAsset: normalized, quoteAsset: "USD" };
}

function alignDown(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.floor(value / step + 1e-12) * step;
}

function alignUp(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.ceil(value / step - 1e-12) * step;
}

function spreadBpsFromBidAsk(bid: number, ask: number): number {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) {
    return Number.NaN;
  }
  const mid = (bid + ask) / 2;
  if (mid <= 0) return Number.NaN;
  return ((ask - bid) / mid) * 10_000;
}

function baseAssetFromProductId(productId: string): string {
  const normalized = normalizeProductId(productId);
  const dashIndex = normalized.indexOf("-");
  if (dashIndex > 0) return normalized.slice(0, dashIndex);
  const suffixes = ["USDT", "USD", "USDC", "BTC", "ETH"];
  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      return normalized.slice(0, -suffix.length);
    }
  }
  return normalized;
}

function chooseProductBook(
  productId: string,
  productBook: CoinbaseProductBookResponse,
  bestBidAsk: CoinbaseBestBidAskResponse
): { bestBid: number; bestAsk: number; bestBidSize: number; bestAskSize: number } | null {
  const primary = productBook.pricebook;
  const bookFromProduct = primary?.product_id === productId ? primary : undefined;
  const bookFromBestBidAsk =
    bestBidAsk.pricebooks?.find((entry) => entry.product_id === productId) ??
    bestBidAsk.pricebooks?.[0];
  const source = bookFromProduct ?? bookFromBestBidAsk;
  const bid = parseNumber(source?.bids?.[0]?.price);
  const ask = parseNumber(source?.asks?.[0]?.price);
  const bidSize = parseNumber(source?.bids?.[0]?.size);
  const askSize = parseNumber(source?.asks?.[0]?.size);
  if (bid === null || ask === null || bid <= 0 || ask < bid) return null;
  return {
    bestBid: bid,
    bestAsk: ask,
    bestBidSize: bidSize ?? 0,
    bestAskSize: askSize ?? 0,
  };
}

function createDefaultContract(
  productId: string,
  defaults: {
    tickSize: number;
    lotSize: number;
    minQuantity: number;
    minNotional: number;
  },
  product?: CoinbaseProduct | null
): FuturesContractMetadata & { minNotional?: number } {
  const tickSize = parseNumber(product?.quote_increment) ?? defaults.tickSize;
  const lotSize = parseNumber(product?.base_increment) ?? defaults.lotSize;
  const minQuantity =
    parseNumber(product?.base_min_size) ??
    parseNumber(product?.quote_min_size) ??
    defaults.minQuantity;
  const { baseAsset, quoteAsset } = splitProductId(productId);
  return {
    id: `coinbase:cfm_perp:${normalizeProductId(productId)}`,
    venueSymbol: {
      venue: "coinbase_cfm_perp",
      code: normalizeProductId(productId),
    },
    kind: "perpetual_swap",
    instrumentType: "perpetual_swap",
    baseAsset: product?.base_increment ? baseAssetFromProductId(productId) : baseAsset,
    quoteAsset,
    settlementAsset: "USD",
    tickSize,
    lotSize,
    minQuantity,
    contractMultiplier: 1,
    ...(defaults.minNotional > 0 ? { minNotional: defaults.minNotional } : {}),
  };
}

function buildBook(
  contract: FuturesContractMetadata,
  book: { bestBid: number; bestAsk: number; bestBidSize: number; bestAskSize: number }
): TopOfBookL1 {
  const midPrice = (book.bestBid + book.bestAsk) / 2;
  return {
    bestBid: alignDown(book.bestBid, contract.tickSize),
    bestAsk: Math.max(
      alignUp(book.bestAsk, contract.tickSize),
      alignDown(book.bestBid, contract.tickSize) + contract.tickSize
    ),
    midPrice,
    spreadBps: spreadBpsFromBidAsk(book.bestBid, book.bestAsk),
    bestBidSize:
      book.bestBidSize > 0
        ? book.bestBidSize
        : Math.max(contract.minQuantity ?? contract.lotSize, contract.lotSize),
    bestAskSize:
      book.bestAskSize > 0
        ? book.bestAskSize
        : Math.max(contract.minQuantity ?? contract.lotSize, contract.lotSize),
  };
}

export class CoinbaseFuturesMarketFeed implements FuturesMarketFeed {
  readonly venueKind: FuturesVenueKind = "perpetual_swap";
  readonly implementationKind: FuturesFeedImplementationKind = "coinbase_public";
  readonly capabilities: FuturesFeedCapabilities = {
    supportsMarkPrice: true,
    supportsIndexPrice: true,
    supportsTopOfBookOnly: true,
    supportsDepth: false,
    supportsSequence: true,
    supportsStaleness: true,
  };
  readonly priceSources: FuturesPriceSources = {
    signalPrice: "coinbase_public_orderbook",
    executionBook: "coinbase_public_orderbook",
    markPrice: "coinbase_public_ticker",
    indexPrice: "coinbase_public_ticker",
  };

  private readonly client: CoinbaseClient;
  private readonly refreshIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly telemetry: CoinbaseFuturesFeedTelemetry;
  private readonly productId: string;
  private readonly tradingMode: "public_paper" | "authenticated_paper" | "live";
  private readonly defaults: {
    tickSize: number;
    lotSize: number;
    minQuantity: number;
    minNotional: number;
  };

  private currentContract: FuturesContractMetadata;
  private currentInstrumentId: InstrumentId;
  private started = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  private lastUpdatedAtMs = 0;
  private lastTradePrice: number | null = null;
  private signalMid: number | null = null;
  private markPrice: number | null = null;
  private indexPrice: number | null = null;
  private book: TopOfBookL1 | null = null;
  private lastError: string | null = null;

  constructor(options: CoinbaseFuturesFeedOptions = {}) {
    const runtime = readRuntimeConfig();
    const exchange =
      runtime.tradingMode === "public_paper"
        ? readCoinbasePublicConfig()
        : readCoinbaseExchangeConfig();
    const configuredProductId = options.productId?.trim() || exchange.productId.trim();
    if (!configuredProductId) {
      throw new CoinbaseFuturesFeedError(
        "Missing COINBASE_PRODUCT_ID. Set a valid futures product id before starting the Coinbase feed."
      );
    }

    this.productId = normalizeProductId(configuredProductId);
    this.tradingMode = runtime.tradingMode;
    this.client = new CoinbaseClient(exchange);
    this.refreshIntervalMs = Math.max(500, options.refreshIntervalMs ?? 1000);
    this.staleAfterMs = Math.max(1_000, options.staleAfterMs ?? 15_000);
    this.telemetry = {
      exchange: "coinbase",
      productId: this.productId,
      feed: "coinbase_public",
      trading: "paper",
      bootstrap: "public_or_skipped",
      signedEndpoints: this.tradingMode !== "public_paper",
    };
    this.defaults = {
      tickSize: exchange.publicTickSize,
      lotSize: exchange.publicLotSize,
      minQuantity: exchange.publicMinQuantity,
      minNotional: exchange.publicMinNotional,
    };
    this.currentContract = {
      id: options.instrumentId ?? `coinbase:cfm_perp:${this.productId}`,
      venueSymbol: {
        venue: "coinbase_cfm_perp",
        code: this.productId,
      },
      kind: "perpetual_swap",
      instrumentType: "perpetual_swap",
      baseAsset: splitProductId(this.productId).baseAsset,
      quoteAsset: splitProductId(this.productId).quoteAsset,
      settlementAsset: splitProductId(this.productId).quoteAsset,
      tickSize: this.defaults.tickSize,
      lotSize: this.defaults.lotSize,
      minQuantity: this.defaults.minQuantity,
      contractMultiplier: 1,
      minNotional: this.defaults.minNotional,
    };
    this.currentInstrumentId = this.currentContract.id;
  }

  get instrumentId(): InstrumentId {
    return this.currentInstrumentId;
  }

  get contract(): FuturesContractMetadata {
    return this.currentContract;
  }

  async bootstrapRest(): Promise<boolean> {
    if (this.tradingMode === "public_paper") {
      try {
        await this.refreshPublicMarketData();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.warn(`[coinbase-feed] public bootstrap skipped/failed: ${this.lastError}`);
      }
      return true;
    }

    try {
      await this.refreshAuthenticatedMarketData();
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error(`[coinbase-feed] bootstrap failed: ${this.lastError}`);
      if (error instanceof CoinbaseApiError) {
        console.error(
          `[coinbase-feed] status=${error.status} body=${error.responseSummary ?? error.responseBody}`
        );
      }
      return false;
    }
  }

  start(): void {
    this.started = true;
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }, this.refreshIntervalMs);
    void this.refresh().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
  }

  stop(): void {
    this.started = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getSignalMid(): number | null {
    return this.signalMid;
  }

  getMarkPrice(): number | null {
    return this.markPrice;
  }

  getIndexPrice(): number | null {
    return this.indexPrice;
  }

  getExecutionBook(): TopOfBookL1 | null {
    return this.book;
  }

  getTopOfBookL1(): TopOfBookL1 | null {
    return this.book;
  }

  getLastMessageAgeMs(nowMs = Date.now()): number {
    if (this.lastUpdatedAtMs <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, nowMs - this.lastUpdatedAtMs);
  }

  getStaleness(nowMs = Date.now()): FeedStaleness {
    const age = this.getLastMessageAgeMs(nowMs);
    return {
      stale: !Number.isFinite(age) || age > this.staleAfterMs,
      reason: !Number.isFinite(age) || age > this.staleAfterMs ? "coinbase_quote_age" : null,
    };
  }

  getSequence(): number {
    return this.sequence;
  }

  getMarketSnapshot(nowMs = Date.now()): FuturesMarketSnapshot | null {
    if (!this.book) return null;
    return {
      contract: this.contract,
      instrumentId: this.instrumentId,
      observedAtMs: this.lastUpdatedAtMs || nowMs,
      signalMid: this.signalMid,
      lastTradePrice: this.lastTradePrice,
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
    if (!this.book) return null;
    return {
      contract: this.contract,
      observedAtMs: this.lastUpdatedAtMs || nowMs,
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
      ...(this.lastTradePrice !== null ? { lastPrice: this.lastTradePrice } : {}),
    };
  }

  private async refresh(): Promise<void> {
    if (this.tradingMode === "public_paper") {
      await this.refreshPublicMarketData();
      return;
    }
    await this.refreshAuthenticatedMarketData();
  }

  private async refreshPublicMarketData(): Promise<void> {
    const [productBook, ticker] = await Promise.all([
      this.client.getPublicProductBook(this.productId),
      this.client.getPublicMarketTicker(this.productId),
    ]);

    const syntheticBestBidAsk: CoinbaseBestBidAskResponse = {
      pricebooks:
        ticker.best_bid || ticker.best_ask
          ? [
              {
                product_id: this.productId,
                bids: ticker.best_bid ? [{ price: ticker.best_bid, size: "1" }] : [],
                asks: ticker.best_ask ? [{ price: ticker.best_ask, size: "1" }] : [],
              },
            ]
          : [],
    };

    const chosenBook = chooseProductBook(
      this.productId,
      productBook,
      syntheticBestBidAsk
    );

    if (!chosenBook) {
      this.lastUpdatedAtMs = Date.now();
      this.sequence += 1;
      this.lastError = null;
      return;
    }

    this.currentContract = {
      ...createDefaultContract(this.productId, this.defaults),
      id: this.currentInstrumentId,
      venueSymbol: {
        venue: "coinbase_cfm_perp",
        code: this.productId,
      },
    };
    this.currentInstrumentId = this.currentContract.id;
    this.book = buildBook(this.currentContract, chosenBook);
    this.signalMid = this.book.midPrice;
    this.markPrice = this.book.midPrice;
    this.indexPrice = this.book.midPrice;
    this.lastTradePrice = parseNumber(ticker.price) ?? this.book.midPrice;
    this.lastUpdatedAtMs = Date.now();
    this.sequence += 1;
    this.lastError = null;
  }

  private async refreshAuthenticatedMarketData(): Promise<void> {
    const [product, productBook, bestBidAsk] = await Promise.all([
      this.client.getProduct(this.productId),
      this.client.getProductBook(this.productId),
      this.client.getBestBidAsk([this.productId]),
    ]);
    const contract = createDefaultContract(this.productId, this.defaults, product);
    this.currentContract = {
      ...contract,
      id: this.currentInstrumentId,
      venueSymbol: {
        venue: "coinbase_cfm_perp",
        code: this.productId,
      },
    };
    this.currentInstrumentId = this.currentContract.id;

    const chosenBook = chooseProductBook(this.productId, productBook, bestBidAsk);
    if (!chosenBook) {
      throw new CoinbaseFuturesFeedError(
        `Coinbase product book did not contain a valid top of book for ${this.productId}.`
      );
    }

    this.book = buildBook(this.currentContract, chosenBook);
    this.signalMid = this.book.midPrice;
    this.markPrice = this.book.midPrice;
    this.indexPrice = this.book.midPrice;
    this.lastTradePrice = parseNumber(product.price) ?? this.book.midPrice;
    this.lastUpdatedAtMs = Date.now();
    this.sequence += 1;
    this.lastError = null;
  }
}

export function createCoinbaseFuturesMarketFeed(
  options?: CoinbaseFuturesFeedOptions
): FuturesMarketFeed {
  return new CoinbaseFuturesMarketFeed(options);
}
