/**
 * Binance Spot public WebSocket + REST bootstrap for BTCUSDT (or configured symbol).
 * @see https://binance-docs.github.io/apidocs/spot/en/
 */
import WebSocket from "ws";
import axios from "axios";

import type { QuoteStaleResult } from "../market/types.js";

const BINANCE_WS_BASE = "wss://stream.binance.com:9443";
const BINANCE_REST = "https://api.binance.com";

export type NormalizedSpotBook = {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  bestBidQty: number;
  bestAskQty: number;
  midPrice: number;
  lastTradePrice: number | null;
  spreadAbs: number;
  spreadBps: number;
  /** Exchange event time (ms) from last bookTicker, or local time if unavailable */
  eventTimeMs: number;
  observedAtMs: number;
};

export type BinanceFeedHealth = {
  connected: boolean;
  connectCount: number;
  disconnectCount: number;
  lastMessageAtMs: number | null;
  messagesTotal: number;
  reconnectScheduled: boolean;
  lastError: string | null;
};

function spreadBpsFromBidAsk(bid: number, ask: number): number {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) {
    return Number.NaN;
  }
  const mid = (bid + ask) / 2;
  if (mid <= 0) return Number.NaN;
  return ((ask - bid) / mid) * 10_000;
}

export class BinanceSpotFeed {
  private readonly symbolLower: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly streams: string[];

  private bestBid = Number.NaN;
  private bestAsk = Number.NaN;
  private bestBidQty = 0;
  private bestAskQty = 0;
  private lastTradePrice: number | null = null;
  private lastEventTimeMs = 0;
  private lastMessageAtMs: number | null = null;

  private connectCount = 0;
  private disconnectCount = 0;
  private messagesTotal = 0;
  private reconnectScheduled = false;
  private lastError: string | null = null;
  private closedByUser = false;

  /** Count of bookTicker payloads applied (bid/ask updated). */
  private bookTickerUpdates = 0;
  /** Last mid after a book update (for debug / flat-feed warning). */
  private lastMidAfterBook: number | null = null;
  /** Consecutive book updates with unchanged mid (8 dp). */
  private unchangedMidStreak = 0;
  private warnedFlatMid = false;
  /** Previous book mid (full precision) for debug delta line. */
  private previousBookMid: number | null = null;

  constructor(options?: {
    symbol?: string;
    /** default: bookTicker + aggTrade for last price */
    streams?: string[];
  }) {
    const sym = (options?.symbol ?? process.env.BINANCE_SYMBOL ?? "BTCUSDT").trim().toUpperCase();
    this.symbolLower = sym.toLowerCase();
    this.streams = options?.streams ?? [`${this.symbolLower}@bookTicker`, `${this.symbolLower}@aggTrade`];
  }

  /** @internal tests */
  _applyBookTickerPayloadForTest(payload: Record<string, unknown>): void {
    this.applyBookTickerPayload(payload);
  }

  /** @internal tests */
  _applyAggTradePayloadForTest(payload: Record<string, unknown>): void {
    this.applyAggTradePayload(payload);
  }

  getSymbol(): string {
    return this.symbolLower.toUpperCase();
  }

  getBinaryOutcomePrices(): null {
    return null;
  }

  getHealth(): BinanceFeedHealth {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      connectCount: this.connectCount,
      disconnectCount: this.disconnectCount,
      lastMessageAtMs: this.lastMessageAtMs,
      messagesTotal: this.messagesTotal,
      reconnectScheduled: this.reconnectScheduled,
      lastError: this.lastError,
    };
  }

  /** Age of last WebSocket message in ms (for stale-feed detection). */
  getLastMessageAgeMs(now = Date.now()): number {
    if (this.lastMessageAtMs === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, now - this.lastMessageAtMs);
  }

  getQuoteStale(now = Date.now()): QuoteStaleResult {
    const age = this.getLastMessageAgeMs(now);
    if (age === Number.POSITIVE_INFINITY) {
      return { stale: true, reason: "no_ws_messages" };
    }
    return { stale: false, reason: null };
  }

  /**
   * Latest normalized book. Returns null if we never received a valid bookTicker
   * (call {@link bootstrapRest} first or wait for WS).
   */
  getNormalizedBook(): NormalizedSpotBook | null {
    if (!Number.isFinite(this.bestBid) || !Number.isFinite(this.bestAsk)) {
      return null;
    }
    const mid = (this.bestBid + this.bestAsk) / 2;
    const spreadAbs = this.bestAsk - this.bestBid;
    const spreadBps = spreadBpsFromBidAsk(this.bestBid, this.bestAsk);
    const now = Date.now();
    return {
      symbol: this.symbolLower.toUpperCase(),
      bestBid: this.bestBid,
      bestAsk: this.bestAsk,
      bestBidQty: this.bestBidQty,
      bestAskQty: this.bestAskQty,
      midPrice: mid,
      lastTradePrice: this.lastTradePrice,
      spreadAbs,
      spreadBps,
      eventTimeMs: this.lastEventTimeMs > 0 ? this.lastEventTimeMs : now,
      observedAtMs: now,
    };
  }

  /** REST snapshot so strategy has prices before first WS frame. */
  async bootstrapRest(): Promise<boolean> {
    try {
      const res = await axios.get<{
        symbol: string;
        bidPrice: string;
        bidQty: string;
        askPrice: string;
        askQty: string;
      }>(`${BINANCE_REST}/api/v3/ticker/bookTicker`, {
        params: { symbol: this.symbolLower.toUpperCase() },
        timeout: 10_000,
        validateStatus: (s) => s === 200,
      });
      const bid = Number(res.data.bidPrice);
      const ask = Number(res.data.askPrice);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return false;
      this.bestBid = bid;
      this.bestAsk = ask;
      this.bestBidQty = Number(res.data.bidQty);
      this.bestAskQty = Number(res.data.askQty);
      this.lastEventTimeMs = Date.now();
      this.lastMessageAtMs = Date.now();
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  start(): void {
    this.closedByUser = false;
    this.connect();
  }

  stop(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectScheduled = false;
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
    const path = this.streams.join("/");
    const url = `${BINANCE_WS_BASE}/stream?streams=${path}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.connectCount += 1;
      this.lastError = null;
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      this.messagesTotal += 1;
      this.lastMessageAtMs = Date.now();
      try {
        const raw = JSON.parse(data.toString()) as {
          stream?: string;
          data?: Record<string, unknown>;
        };
        const streamName = typeof raw.stream === "string" ? raw.stream : "";
        const payload = (raw.data ?? raw) as Record<string, unknown>;
        const ev = payload["e"] as string | undefined;

        // aggTrade first — has e === "aggTrade"
        if (ev === "aggTrade") {
          this.applyAggTradePayload(payload);
          return;
        }

        /**
         * Binance `<symbol>@bookTicker` payloads do NOT include event type `e`
         * (only u, s, b, B, a, A). Combined streams wrap as { stream, data }.
         * @see https://binance-docs.github.io/apidocs/spot/en/#individual-symbol-book-ticker-streams
         */
        const fromBookTickerStream = streamName.includes("@bookTicker");
        const bookTickerByEvent = ev === "bookTicker";
        const bRaw = payload["b"];
        const aRaw = payload["a"];
        const bookTickerShape =
          bRaw != null &&
          aRaw != null &&
          !Array.isArray(bRaw) &&
          !Array.isArray(aRaw) &&
          ev !== "depthUpdate";

        if (fromBookTickerStream || bookTickerByEvent || bookTickerShape) {
          this.applyBookTickerPayload(payload);
        }
      } catch {
        /* ignore malformed */
      }
    });

    this.ws.on("close", () => {
      this.ws = null;
      this.disconnectCount += 1;
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.lastError = err.message;
    });
  }

  private applyAggTradePayload(payload: Record<string, unknown>): void {
    const p = Number(payload["p"]);
    if (Number.isFinite(p)) {
      this.lastTradePrice = p;
      const et = Number(payload["E"]);
      if (Number.isFinite(et)) this.lastEventTimeMs = et;
    }
  }

  private applyBookTickerPayload(payload: Record<string, unknown>): void {
    const bid = Number(payload["b"]);
    const ask = Number(payload["a"]);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) {
      return;
    }
    this.bestBid = bid;
    this.bestAsk = ask;
    this.bestBidQty = Number(payload["B"] ?? 0);
    this.bestAskQty = Number(payload["A"] ?? 0);
    const et = Number(payload["E"]);
    this.lastEventTimeMs = Number.isFinite(et) ? et : Date.now();

    this.bookTickerUpdates += 1;
    const mid = (bid + ask) / 2;
    const midKey = Math.round(mid * 1e8) / 1e8;
    const deltaVsPrevBook =
      this.previousBookMid !== null && Number.isFinite(this.previousBookMid)
        ? mid - this.previousBookMid
        : null;
    this.previousBookMid = mid;

    if (this.lastMidAfterBook !== null && midKey === this.lastMidAfterBook) {
      this.unchangedMidStreak += 1;
    } else {
      this.unchangedMidStreak = 0;
      this.warnedFlatMid = false;
    }
    this.lastMidAfterBook = midKey;

    this.maybeDebugLogBook(bid, ask, mid, deltaVsPrevBook);
    this.maybeWarnFlatMid();
  }

  private maybeDebugLogBook(
    bid: number,
    ask: number,
    mid: number,
    deltaVsPrevBook: number | null
  ): void {
    const every = Number.parseInt(process.env.BINANCE_FEED_DEBUG_LOG_EVERY_N ?? "", 10);
    if (!Number.isFinite(every) || every <= 0) return;
    if (this.bookTickerUpdates % every !== 0) return;
    const deltaStr =
      deltaVsPrevBook !== null ? ` deltaVsPrevBook=${deltaVsPrevBook.toFixed(8)}` : "";
    console.log(
      `[binance-feed] bookTicker#${this.bookTickerUpdates} bid=${bid} ask=${ask} mid=${mid}${deltaStr} wsMsgsTotal=${this.messagesTotal}`
    );
  }

  private maybeWarnFlatMid(): void {
    const threshold = Number.parseInt(
      process.env.BINANCE_FEED_WARN_UNCHANGED_MID_AFTER ?? "5000",
      10
    );
    if (!Number.isFinite(threshold) || threshold <= 0) return;
    if (this.unchangedMidStreak < threshold || this.warnedFlatMid) return;
    this.warnedFlatMid = true;
    console.warn(
      `[binance-feed] mid unchanged for ${this.unchangedMidStreak} consecutive bookTicker updates (bid/ask may be static). lastMid=${this.lastMidAfterBook}`
    );
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    const delay = Math.min(30_000, 1000 * Math.pow(1.5, Math.min(8, this.disconnectCount % 9)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectScheduled = false;
      this.reconnectTimer = null;
      if (!this.closedByUser) this.connect();
    }, delay);
  }
}

/**
 * Local paper feed for `npm start` / tests: fixed mid with a tight synthetic book.
 * Implements the same surface as {@link BinanceSpotFeed} used by {@link BotContext}.
 */
export class PaperBinanceFeed {
  private readonly symbolUpper: string;
  private mid: number;
  private spreadBps: number;
  private lastMessageAtMs = Date.now();

  constructor(options?: { symbol?: string; mid?: number; spreadBps?: number }) {
    const sym = (options?.symbol ?? process.env.BINANCE_SYMBOL ?? "BTCUSDT").trim().toUpperCase();
    this.symbolUpper = sym;
    this.mid = options?.mid ?? 95_000;
    this.spreadBps = options?.spreadBps ?? 3;
  }

  setMid(mid: number): void {
    this.mid = mid;
    this.lastMessageAtMs = Date.now();
  }

  getSymbol(): string {
    return this.symbolUpper;
  }

  getBinaryOutcomePrices(): null {
    return null;
  }

  getHealth(): BinanceFeedHealth {
    return {
      connected: true,
      connectCount: 1,
      disconnectCount: 0,
      lastMessageAtMs: this.lastMessageAtMs,
      messagesTotal: 1,
      reconnectScheduled: false,
      lastError: null,
    };
  }

  getLastMessageAgeMs(now = Date.now()): number {
    return Math.max(0, now - this.lastMessageAtMs);
  }

  getQuoteStale(now = Date.now()): QuoteStaleResult {
    void now;
    return { stale: false, reason: null };
  }

  getNormalizedBook(): NormalizedSpotBook | null {
    const half = (this.spreadBps / 10_000 / 2) * this.mid;
    const bid = this.mid - half;
    const ask = this.mid + half;
    const spreadAbs = ask - bid;
    const spreadBps = (spreadAbs / this.mid) * 10_000;
    return {
      symbol: this.symbolUpper,
      bestBid: bid,
      bestAsk: ask,
      bestBidQty: 0,
      bestAskQty: 0,
      midPrice: this.mid,
      lastTradePrice: this.mid,
      spreadAbs,
      spreadBps,
      eventTimeMs: Date.now(),
      observedAtMs: Date.now(),
    };
  }

  async bootstrapRest(): Promise<boolean> {
    this.lastMessageAtMs = Date.now();
    return true;
  }

  start(): void {
    this.lastMessageAtMs = Date.now();
  }

  stop(): void {
    /* no-op */
  }
}

