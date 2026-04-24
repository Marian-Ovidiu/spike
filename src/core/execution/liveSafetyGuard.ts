import { assertCanUseLiveExecution as assertCanUseLiveExecutionConfig, readLiveSafetyConfig } from "../../config/env.js";

export type LiveOrderSide = "BUY" | "SELL";

export type LiveSafetyGuardConfig = {
  liveTradingEnabled: boolean;
  maxNotionalPerTrade: number;
  dailyMaxLossQuote: number;
  maxOpenPositions: number;
  allowedSymbols: string[];
};

export type LiveOrderIntentInput = {
  symbol: string;
  side: string;
  notional: number;
  reduceOnly?: boolean;
  currentOpenPositions: number;
  dailyLossQuote: number;
};

export type LiveOrderIntent = {
  symbol: string;
  side: LiveOrderSide;
  notional: number;
  reduceOnly: boolean;
  currentOpenPositions: number;
  dailyLossQuote: number;
};

export type LiveSafetyGuardErrorCode =
  | "live_trading_disabled"
  | "invalid_symbol"
  | "invalid_side"
  | "notional_too_large"
  | "daily_loss_limit_exceeded"
  | "too_many_open_positions"
  | "invalid_order_intent";

export class LiveSafetyGuardError extends Error {
  readonly code: LiveSafetyGuardErrorCode;

  constructor(code: LiveSafetyGuardErrorCode, message: string) {
    super(message);
    this.name = "LiveSafetyGuardError";
    this.code = code;
  }
}

export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 4) return `${trimmed.slice(0, 1)}***`;
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
  }
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

function readLiveSafetyGuardConfig(): LiveSafetyGuardConfig {
  const env = readLiveSafetyConfig();
  return {
    liveTradingEnabled: env.liveTradingEnabled,
    maxNotionalPerTrade: env.maxNotionalPerTrade,
    dailyMaxLossQuote: env.dailyMaxLossQuote,
    maxOpenPositions: env.maxOpenPositions,
    allowedSymbols: env.allowedSymbols,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fail(code: LiveSafetyGuardErrorCode, message: string): never {
  throw new LiveSafetyGuardError(code, message);
}

export function assertLiveTradingEnabled(): true {
  const cfg = readLiveSafetyGuardConfig();
  if (!cfg.liveTradingEnabled) {
    fail(
      "live_trading_disabled",
      "LIVE_TRADING_ENABLED is not true; live order intents are blocked."
    );
  }
  return true;
}

export function validateLiveOrderIntent(
  input: LiveOrderIntentInput
): LiveOrderIntent {
  const cfg = readLiveSafetyGuardConfig();
  if (!cfg.liveTradingEnabled) {
    fail(
      "live_trading_disabled",
      "LIVE_TRADING_ENABLED is not true; live order intents are blocked."
    );
  }

  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol) {
    fail("invalid_symbol", "symbol is required.");
  }
  if (!cfg.allowedSymbols.includes(symbol)) {
    fail(
      "invalid_symbol",
      `symbol ${symbol} is not allowed. Allowed symbols: ${cfg.allowedSymbols.join(", ")}.`
    );
  }

  const side = input.side.trim().toUpperCase();
  if (side !== "BUY" && side !== "SELL") {
    fail(
      "invalid_side",
      `side must be BUY or SELL, received ${JSON.stringify(input.side)}.`
    );
  }

  if (!isFiniteNumber(input.notional) || input.notional <= 0) {
    fail("invalid_order_intent", "notional must be a finite number greater than 0.");
  }
  if (input.notional > cfg.maxNotionalPerTrade) {
    fail(
      "notional_too_large",
      `notional ${input.notional} exceeds LIVE_MAX_NOTIONAL_PER_TRADE=${cfg.maxNotionalPerTrade}.`
    );
  }

  if (!isFiniteNumber(input.currentOpenPositions) || input.currentOpenPositions < 0) {
    fail(
      "invalid_order_intent",
      "currentOpenPositions must be a finite number greater than or equal to 0."
    );
  }
  if (input.currentOpenPositions >= cfg.maxOpenPositions) {
    fail(
      "too_many_open_positions",
      `currentOpenPositions=${input.currentOpenPositions} reaches LIVE_MAX_OPEN_POSITIONS=${cfg.maxOpenPositions}.`
    );
  }

  if (!isFiniteNumber(input.dailyLossQuote) || input.dailyLossQuote < 0) {
    fail(
      "invalid_order_intent",
      "dailyLossQuote must be a finite number greater than or equal to 0."
    );
  }
  if (input.dailyLossQuote > cfg.dailyMaxLossQuote) {
    fail(
      "daily_loss_limit_exceeded",
      `dailyLossQuote ${input.dailyLossQuote} exceeds LIVE_DAILY_MAX_LOSS_QUOTE=${cfg.dailyMaxLossQuote}.`
    );
  }

  return {
    symbol,
    side: side as LiveOrderSide,
    notional: input.notional,
    reduceOnly: input.reduceOnly ?? false,
    currentOpenPositions: input.currentOpenPositions,
    dailyLossQuote: input.dailyLossQuote,
  };
}

export function assertCanUseLiveExecution(
  config: Parameters<typeof assertCanUseLiveExecutionConfig>[0]
): true {
  return assertCanUseLiveExecutionConfig(config);
}
