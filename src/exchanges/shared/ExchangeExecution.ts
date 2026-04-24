import type { ExchangeId, InstrumentRef } from "./ExchangeMarketData.js";
import type { FeeSchedule } from "./ExchangeMetadata.js";

export type OrderIntent = {
  readonly exchangeId: ExchangeId;
  readonly instrument: InstrumentRef;
  readonly side: "buy" | "sell";
  readonly orderType: "market" | "limit";
  readonly quantity: number;
  readonly price?: number;
  readonly reduceOnly?: boolean;
  readonly clientOrderId?: string;
  readonly timeInForce?: "GTC" | "IOC" | "FOK";
};

export type FillResult = {
  readonly exchangeId: ExchangeId;
  readonly instrument: InstrumentRef;
  readonly orderId?: string;
  readonly clientOrderId?: string;
  readonly status: "accepted" | "rejected" | "filled" | "partial";
  readonly filledQuantity: number;
  readonly filledPrice?: number;
  readonly feeSchedule?: FeeSchedule;
  readonly feeQuote?: number;
  readonly reason?: string;
};

export interface ExchangeExecution {
  readonly exchangeId: ExchangeId;
  readonly feeSchedule?: FeeSchedule;
  previewOrderIntent(intent: OrderIntent): FillResult;
}

