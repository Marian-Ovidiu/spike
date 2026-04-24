import axios from "axios";
import WebSocket from "ws";

import type { InstrumentId } from "../domain/instrument.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { FeedStaleness } from "./staleness.js";
import type {
  FuturesContractMetadata,
  FuturesFeedCapabilities,
  FuturesFeedImplementationKind,
  FuturesMarketFeed,
  FuturesMarketTick,
  FuturesMarketSnapshot,
  FuturesPriceSources,
  FuturesVenueKind,
} from "./futuresFeed.js";
import { bybitUsdmPerpInstrumentId } from "./instrumentRef.js";
import { readExchangeDefaults } from "../../config/env.js";

type BybitOrderbookLevel = [string, string];

type BybitOrderbookMessage = {
  topic?: string;
  type?: string;
  ts?: number;
  data?: {
    s?: string;
    b?: BybitOrderbookLevel[];
    a?: BybitOrderbookLevel[];
    u?: number;
    seq?: number;
    cts?: number;
  };
};

type BybitTickerMessage = {
  topic?: string;
  type?: string;
  ts?: number;
  cs?: number;
  data?: {
    symbol?: string;
    lastPrice?: string;
    markPrice?: string;
    indexPrice?: string;
    bid1Price?: string;
    bid1Size?: string;
    ask1Price?: string;
    ask1Size?: string;
    cs?: number;
    ts?: number;
  };
};

type BybitTrade = {
  T?: number;
  s?: string;
  S?: string;
  v?: string;
  p?: string;
  L?: string;
};

type BybitTradeMessage = {
  topic?: string;
  type?: string;
  ts?: number;
  data?: BybitTrade[];
};

export type BybitFuturesFeedOptions = {
  symbol?: string;
  category?: "linear" | "inverse";
  wsPublicUrl?: string;
  restBaseUrl?: string;
  instrumentId?: InstrumentId;
  staleAfterMs?: number;
};

export type BybitFuturesTickerState = {
  lastPrice: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  bid1Price: number | null;
  bid1Size: number | null;
  ask1Price: number | null;
  ask1Size: number | null;
  sequence: number | null;
};

export type BybitFuturesFeedTelemetry = {
  exchange: "bybit";
  category: "linear" | "inverse";
  symbol: string;
  feed: "public_ws";
  trading: "paper";
};

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.replace(/\/+$/, "") : value;
}

function parseNumber(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function spreadBpsFromBidAsk(bid: number, ask: number): number {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) {
    return Number.NaN;
  }
  const mid = (bid + ask) / 2;
  if (mid <= 0) return Number.NaN;
  return ((ask - bid) / mid) * 10_000;
}

function alignDown(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.floor(value / step + 1e-12) * step;
}

function alignUp(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.ceil(value / step - 1e-12) * step;
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

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function baseAssetFromSymbol(symbol: string): string {
  const s = normalizeSymbol(symbol);
  const suffixes = ["USDT", "USD", "USDC", "BUSD", "FDUSD"];
  for (const suffix of suffixes) {
    if (s.endsWith(suffix) && s.length > suffix.length) {
      return s.slice(0, -suffix.length);
    }
  }
  return s;
}

function toOrderbookBook(
  symbol: string,
  orderbook: NonNullable<BybitOrderbookMessage["data"]>,
  contract: FuturesContractMetadata
): TopOfBookL1 | null {
  const bid = orderbook.b?.[0];
  const ask = orderbook.a?.[0];
  if (!bid || !ask) return null;
  const bestBid = parseNumber(bid[0]);
  const bestAsk = parseNumber(ask[0]);
  const bestBidSize = parseNumber(bid[1]);
  const bestAskSize = parseNumber(ask[1]);
  if (
    bestBid === null ||
    bestAsk === null ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(bestAsk) ||
    bestBid <= 0 ||
    bestAsk < bestBid
  ) {
    return null;
  }
  const midPrice = (bestBid + bestAsk) / 2;
  return {
    bestBid,
    bestAsk,
    midPrice,
    spreadBps: spreadBpsFromBidAsk(bestBid, bestAsk),
    bestBidSize:
      bestBidSize !== null ? bestBidSize : Math.max(contract.minQuantity ?? contract.lotSize, contract.lotSize),
    bestAskSize:
      bestAskSize !== null ? bestAskSize : Math.max(contract.minQuantity ?? contract.lotSize, contract.lotSize),
  };
}

function toBookFromTicker(
  ticker: NonNullable<BybitTickerMessage["data"]>,
  contract: FuturesContractMetadata
): TopOfBookL1 | null {
  const bid = parseNumber(ticker.bid1Price);
  const ask = parseNumber(ticker.ask1Price);
  if (bid === null || ask === null || bid <= 0 || ask < bid) return null;
  const midPrice = (bid + ask) / 2;
  return {
    bestBid: bid,
    bestAsk: ask,
    midPrice,
    spreadBps: spreadBpsFromBidAsk(bid, ask),
    bestBidSize:
      parseNumber(ticker.bid1Size) ?? Math.max(contract.minQuantity ?? contract.lotSize, contract.lotSize),
    bestAskSize:
      parseNumber(ticker.ask1Size) ?? Math.max(contract.minQuantity ?? contract.lotSize, contract.lotSize),
  };
}

function createDefaultContract(symbol: string): FuturesContractMetadata {
  const u = normalizeSymbol(symbol);
  return {
    id: bybitUsdmPerpInstrumentId(u),
    venueSymbol: {
      venue: "bybit_usdm_perp",
      code: u,
    },
    kind: "perpetual_swap",
    instrumentType: "perpetual_swap",
    baseAsset: baseAssetFromSymbol(u),
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    tickSize: 0.1,
    lotSize: 0.001,
    minQuantity: 0.001,
    contractMultiplier: 1,
  };
}

export function parseBybitFuturesOrderbookMessage(
  message: BybitOrderbookMessage
): TopOfBookL1 | null {
  if (!message.data) return null;
  const symbol = message.data.s ?? "";
  const contract = createDefaultContract(symbol || "BTCUSDT");
  return toOrderbookBook(symbol, message.data, contract);
}

export function parseBybitFuturesTickerMessage(
  message: BybitTickerMessage
): BybitFuturesTickerState {
  const data = message.data ?? {};
  return {
    lastPrice: parseNumber(data.lastPrice),
    markPrice: parseNumber(data.markPrice),
    indexPrice: parseNumber(data.indexPrice),
    bid1Price: parseNumber(data.bid1Price),
    bid1Size: parseNumber(data.bid1Size),
    ask1Price: parseNumber(data.ask1Price),
    ask1Size: parseNumber(data.ask1Size),
    sequence: parseNumber(data.cs ?? message.cs),
  };
}

export function parseBybitFuturesTradeMessage(
  message: BybitTradeMessage
): number | null {
  const trades = message.data ?? [];
  if (trades.length === 0) return null;
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    const price = parseNumber(trades[i]?.p);
    if (price !== null) return price;
  }
  return null;
}

export function resolveBybitFuturesTelemetry(
  symbol: string,
  category: "linear" | "inverse"
): BybitFuturesFeedTelemetry {
  return {
    exchange: "bybit",
    category,
    symbol: normalizeSymbol(symbol),
    feed: "public_ws",
    trading: "paper",
  };
}

export class BybitFuturesMarketFeed implements FuturesMarketFeed {
  readonly contract: FuturesContractMetadata;
  readonly instrumentId: InstrumentId;
  readonly venueKind: FuturesVenueKind = "perpetual_swap";
  readonly implementationKind: FuturesFeedImplementationKind = "bybit_public_ws";
  readonly capabilities: FuturesFeedCapabilities = {
    supportsMarkPrice: true,
    supportsIndexPrice: true,
    supportsTopOfBookOnly: true,
    supportsDepth: false,
    supportsSequence: true,
    supportsStaleness: true,
  };
  readonly priceSources: FuturesPriceSources = {
    signalPrice: "bybit_public_orderbook",
    executionBook: "bybit_public_orderbook",
    markPrice: "bybit_public_ticker",
    indexPrice: "bybit_public_ticker",
  };

  private readonly category: "linear" | "inverse";
  private readonly symbol: string;
  private readonly wsPublicUrl: string;
  private readonly restBaseUrl: string;
  private readonly staleAfterMs: number;
  private readonly telemetry: BybitFuturesFeedTelemetry;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private closedByUser = false;
  private announced = false;
  private sequence = 0;
  private lastMessageAtMs: number | null = null;
  private book: TopOfBookL1 | null = null;
  private lastTradePrice: number | null = null;
  private lastMarkPrice: number | null = null;
  private lastIndexPrice: number | null = null;
  private lastTicker: BybitFuturesTickerState = {
    lastPrice: null,
    markPrice: null,
    indexPrice: null,
    bid1Price: null,
    bid1Size: null,
    ask1Price: null,
    ask1Size: null,
    sequence: null,
  };

  constructor(options: BybitFuturesFeedOptions = {}) {
    const defaults = readExchangeDefaults().bybit;
    this.category = options.category ?? defaults.category;
    this.symbol = normalizeSymbol(options.symbol ?? defaults.symbol);
    const testnet = defaults.testnet;
    this.wsPublicUrl =
      options.wsPublicUrl?.trim() ||
      defaults.wsPublicUrl.trim() ||
      (testnet
        ? `wss://stream-testnet.bybit.com/v5/public/${this.category}`
        : `wss://stream.bybit.com/v5/public/${this.category}`);
    this.restBaseUrl = trimTrailingSlash(
      options.restBaseUrl?.trim() ||
        defaults.baseUrl.trim() ||
        (testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com")
    );
    this.staleAfterMs = options.staleAfterMs ?? 15_000;
    this.contract =
      options.instrumentId !== undefined
        ? {
            id: options.instrumentId,
            venueSymbol: { venue: "bybit_usdm_perp", code: this.symbol },
            kind: "perpetual_swap",
            instrumentType: "perpetual_swap",
            baseAsset: baseAssetFromSymbol(this.symbol),
            quoteAsset: "USDT",
            settlementAsset: "USDT",
            tickSize: 0.1,
            lotSize: 0.001,
            minQuantity: 0.001,
            contractMultiplier: 1,
          }
        : createDefaultContract(this.symbol);
    this.instrumentId = this.contract.id;
    this.telemetry = resolveBybitFuturesTelemetry(this.symbol, this.category);
  }

  getSignalMid(): number | null {
    const bookMid = this.book?.midPrice;
    if (bookMid !== undefined && bookMid !== null && Number.isFinite(bookMid)) return bookMid;
    if (this.lastTicker.bid1Price !== null && this.lastTicker.ask1Price !== null) {
      return (this.lastTicker.bid1Price + this.lastTicker.ask1Price) / 2;
    }
    if (this.lastMarkPrice !== null && Number.isFinite(this.lastMarkPrice)) return this.lastMarkPrice;
    return this.lastTradePrice;
  }

  getMarkPrice(): number | null {
    return this.lastMarkPrice;
  }

  getIndexPrice(): number | null {
    return this.lastIndexPrice;
  }

  getExecutionBook(): TopOfBookL1 | null {
    return this.book;
  }

  getTopOfBookL1(): TopOfBookL1 | null {
    return this.getExecutionBook();
  }

  getLastMessageAgeMs(nowMs = Date.now()): number {
    if (this.lastMessageAtMs === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, nowMs - this.lastMessageAtMs);
  }

  getStaleness(nowMs = Date.now()): FeedStaleness {
    const age = this.getLastMessageAgeMs(nowMs);
    if (age === Number.POSITIVE_INFINITY) {
      return { stale: true, reason: "no_ws_messages" };
    }
    return {
      stale: age > this.staleAfterMs,
      reason: age > this.staleAfterMs ? "bybit_ws_stale" : null,
    };
  }

  getSequence(): number {
    return this.sequence;
  }

  getMarketSnapshot(nowMs = Date.now()): FuturesMarketSnapshot | null {
    const book = this.getExecutionBook();
    if (!isExecutableBook(book)) return null;
    return {
      instrumentId: this.instrumentId,
      observedAtMs: nowMs,
      signalMid: this.getSignalMid(),
      lastTradePrice: this.lastTradePrice,
      book,
      staleness: this.getStaleness(nowMs),
      contract: this.contract,
      markPrice: this.getMarkPrice(),
      indexPrice: this.getIndexPrice(),
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
    const book = this.getExecutionBook();
    if (!isExecutableBook(book)) return null;
    const lastPrice = this.lastTradePrice ?? this.lastTicker.lastPrice;
    const tick: FuturesMarketTick = {
      observedAtMs: nowMs,
      instrumentId: this.instrumentId,
      contract: this.contract,
      book,
      signalMid: this.getSignalMid(),
      markPrice: this.getMarkPrice(),
      indexPrice: this.getIndexPrice(),
      sequence: this.sequence,
      signalPriceSource: this.priceSources.signalPrice,
      executionBookSource: this.priceSources.executionBook,
      markPriceSource: this.priceSources.markPrice,
      indexPriceSource: this.priceSources.indexPrice,
      ...(lastPrice !== null ? { lastPrice } : {}),
    };
    return tick;
  }

  async bootstrapRest(): Promise<boolean> {
    try {
      const [orderbookRes, tickerRes] = await Promise.all([
        axios.get<{
          retCode: number;
          retMsg: string;
          result: {
            s: string;
            b: BybitOrderbookLevel[];
            a: BybitOrderbookLevel[];
            u?: number;
            seq?: number;
            ts?: number;
          };
        }>(`${this.restBaseUrl}/v5/market/orderbook`, {
          params: { category: this.category, symbol: this.symbol, limit: 1 },
          timeout: 10_000,
          validateStatus: (status) => status >= 200 && status < 300,
        }),
        axios.get<{
          retCode: number;
          retMsg: string;
          result: { category: string; list: Array<BybitTickerMessage["data"]> };
        }>(`${this.restBaseUrl}/v5/market/tickers`, {
          params: { category: this.category, symbol: this.symbol },
          timeout: 10_000,
          validateStatus: (status) => status >= 200 && status < 300,
        }),
      ]);

      const orderbook = orderbookRes.data.result;
      const ticker = tickerRes.data.result.list[0] ?? undefined;

      const contract = this.contract;
      const book = toOrderbookBook(this.symbol, orderbook, contract);
      if (book) {
        this.book = book;
        this.sequence = orderbook.seq ?? this.sequence + 1;
      }

      if (ticker) {
        this.lastTicker = parseBybitFuturesTickerMessage({ data: ticker, type: "snapshot" });
        this.lastTradePrice = this.lastTicker.lastPrice;
        this.lastMarkPrice = this.lastTicker.markPrice;
        this.lastIndexPrice = this.lastTicker.indexPrice;
      }

      this.lastMessageAtMs = Date.now();
      return book !== null || ticker !== undefined;
    } catch {
      return false;
    }
  }

  start(): void {
    this.closedByUser = false;
    this.started = true;
    if (!this.announced) {
      this.announced = true;
      console.log(
        `exchange=${this.telemetry.exchange} category=${this.telemetry.category} symbol=${this.telemetry.symbol} feed=${this.telemetry.feed} trading=${this.telemetry.trading}`
      );
    }
    this.connect();
  }

  stop(): void {
    this.closedByUser = true;
    this.started = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.closedByUser) return;
    if (this.ws !== null) return;

    this.ws = new WebSocket(this.wsPublicUrl);
    this.ws.on("open", () => {
      this.subscribe();
      this.startPing();
    });
    this.ws.on("message", (data: WebSocket.RawData) => {
      this.lastMessageAtMs = Date.now();
      this.handleMessage(data.toString());
    });
    this.ws.on("close", () => {
      this.cleanupSocket();
      this.scheduleReconnect();
    });
    this.ws.on("error", () => {
      this.cleanupSocket();
      this.scheduleReconnect();
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      op: "subscribe",
      args: [
        `tickers.${this.symbol}`,
        `orderbook.1.${this.symbol}`,
        `publicTrade.${this.symbol}`,
      ],
    };
    this.ws.send(JSON.stringify(msg));
  }

  private startPing(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 20_000);
  }

  private cleanupSocket(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) {
        this.connect();
      }
    }, 2_000);
  }

  private handleMessage(raw: string): void {
    let parsed: BybitOrderbookMessage | BybitTickerMessage | BybitTradeMessage | null = null;
    try {
      parsed = JSON.parse(raw) as BybitOrderbookMessage | BybitTickerMessage | BybitTradeMessage;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const topic = typeof parsed.topic === "string" ? parsed.topic : "";
    if (topic.startsWith("orderbook.1.")) {
      this.applyOrderbookMessage(parsed as BybitOrderbookMessage);
      return;
    }
    if (topic.startsWith("tickers.")) {
      this.applyTickerMessage(parsed as BybitTickerMessage);
      return;
    }
    if (topic.startsWith("publicTrade.")) {
      this.applyTradeMessage(parsed as BybitTradeMessage);
    }
  }

  private applyOrderbookMessage(message: BybitOrderbookMessage): void {
    if (!message.data) return;
    const book = toOrderbookBook(this.symbol, message.data, this.contract);
    if (!book) return;
    this.book = book;
    if (typeof message.data.seq === "number" && Number.isFinite(message.data.seq)) {
      this.sequence = Math.max(this.sequence, message.data.seq);
    } else {
      this.sequence += 1;
    }
  }

  private applyTickerMessage(message: BybitTickerMessage): void {
    this.lastTicker = {
      lastPrice:
        message.data?.lastPrice !== undefined
          ? parseNumber(message.data.lastPrice)
          : this.lastTicker.lastPrice,
      markPrice:
        message.data?.markPrice !== undefined
          ? parseNumber(message.data.markPrice)
          : this.lastTicker.markPrice,
      indexPrice:
        message.data?.indexPrice !== undefined
          ? parseNumber(message.data.indexPrice)
          : this.lastTicker.indexPrice,
      bid1Price:
        message.data?.bid1Price !== undefined
          ? parseNumber(message.data.bid1Price)
          : this.lastTicker.bid1Price,
      bid1Size:
        message.data?.bid1Size !== undefined
          ? parseNumber(message.data.bid1Size)
          : this.lastTicker.bid1Size,
      ask1Price:
        message.data?.ask1Price !== undefined
          ? parseNumber(message.data.ask1Price)
          : this.lastTicker.ask1Price,
      ask1Size:
        message.data?.ask1Size !== undefined
          ? parseNumber(message.data.ask1Size)
          : this.lastTicker.ask1Size,
      sequence:
        message.data?.cs !== undefined
          ? parseNumber(message.data.cs)
          : this.lastTicker.sequence,
    };
    this.lastTradePrice = this.lastTicker.lastPrice;
    this.lastMarkPrice = this.lastTicker.markPrice;
    this.lastIndexPrice = this.lastTicker.indexPrice;

    if (!this.book) {
      const book = toBookFromTicker(message.data ?? {}, this.contract);
      if (book) this.book = book;
    }
    if (this.lastTicker.sequence !== null) {
      this.sequence = Math.max(this.sequence, this.lastTicker.sequence);
    } else {
      this.sequence += 1;
    }
  }

  private applyTradeMessage(message: BybitTradeMessage): void {
    const tradePrice = parseBybitFuturesTradeMessage(message);
    if (tradePrice !== null) {
      this.lastTradePrice = tradePrice;
      this.sequence += 1;
    }
  }
}

export function createBybitFuturesMarketFeed(
  options?: BybitFuturesFeedOptions
): FuturesMarketFeed {
  return new BybitFuturesMarketFeed(options);
}
