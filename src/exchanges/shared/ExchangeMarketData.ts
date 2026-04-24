import type { InstrumentId } from "../../core/domain/instrument.js";
import type { FeedStaleness } from "../../core/market/staleness.js";

export type ExchangeId = "coinbase" | "binance" | "bybit";

export type InstrumentRef = {
  readonly exchangeId: ExchangeId;
  readonly symbol: string;
  readonly instrumentId?: InstrumentId;
  readonly venueSymbol?: string;
};

export type BookSnapshot = {
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly midPrice: number;
  readonly spreadBps: number;
  readonly bestBidSize?: number;
  readonly bestAskSize?: number;
};

export type TradeTick = {
  readonly exchangeId: ExchangeId;
  readonly instrument: InstrumentRef;
  readonly observedAtMs: number;
  readonly price: number;
  readonly size?: number;
  readonly side?: "buy" | "sell";
  readonly sequence?: number;
};

export type MarketSnapshot = {
  readonly exchangeId: ExchangeId;
  readonly instrument: InstrumentRef;
  readonly observedAtMs: number;
  readonly signalMid: number | null;
  readonly lastTradePrice: number | null;
  readonly book: BookSnapshot | null;
  readonly staleness: FeedStaleness;
  readonly markPrice?: number | null;
  readonly indexPrice?: number | null;
  readonly sequence?: number;
};

export interface ExchangeMarketData {
  readonly exchangeId: ExchangeId;
  readonly instrument: InstrumentRef;
  getBook(nowMs?: number): BookSnapshot | null;
  getTradeTick(nowMs?: number): TradeTick | null;
  getMarketSnapshot(nowMs?: number): MarketSnapshot | null;
}

