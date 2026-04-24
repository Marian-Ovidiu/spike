import type { ExchangeId, InstrumentRef } from "./ExchangeMarketData.js";

export type InstrumentKind = "perpetual_swap" | "dated_future" | "spot";

export type InstrumentMetadata = {
  readonly exchangeId: ExchangeId;
  readonly instrumentRef: InstrumentRef;
  readonly symbol: string;
  readonly kind: InstrumentKind;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly settlementAsset: string;
  readonly tickSize: number;
  readonly lotSize: number;
  readonly minQuantity?: number;
  readonly contractMultiplier?: number;
};

export type FeeSchedule = {
  readonly makerFeeBps: number;
  readonly takerFeeBps: number;
  readonly fundingFeeBps?: number;
};

export type ExchangeMetadata = {
  readonly exchangeId: ExchangeId;
  readonly instrument: InstrumentMetadata;
  readonly feeSchedule?: FeeSchedule;
  readonly venueLabel?: string;
};
