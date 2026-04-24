import type { ExchangeId, InstrumentRef } from "./ExchangeMarketData.js";

export type AccountBalance = {
  readonly asset: string;
  readonly walletBalance: number;
  readonly availableBalance?: number;
  readonly unrealizedPnl?: number;
  readonly marginBalance?: number;
};

export type PositionSnapshot = {
  readonly exchangeId: ExchangeId;
  readonly instrument: InstrumentRef;
  readonly side: "long" | "short";
  readonly quantity: number;
  readonly avgEntryPrice?: number;
  readonly markPrice?: number;
  readonly unrealizedPnl?: number;
  readonly leverage?: number;
  readonly liquidationPrice?: number;
  readonly notional?: number;
  readonly isolated?: boolean;
  readonly updatedAtMs?: number;
};

export type AccountSnapshot = {
  readonly exchangeId: ExchangeId;
  readonly accountType: string;
  readonly balances: readonly AccountBalance[];
  readonly positions: readonly PositionSnapshot[];
  readonly equityQuote?: number;
  readonly availableQuote?: number;
  readonly totalWalletBalanceQuote?: number;
};

