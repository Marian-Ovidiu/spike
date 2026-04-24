import type { BinanceFuturesExchangeInfoSymbolFilter } from "./binanceFuturesClient.js";

export type BinanceFuturesOrderSide = "BUY" | "SELL";
export type BinanceFuturesOrderType = "MARKET" | "LIMIT";

export type FuturesOrderValidatorInput = {
  symbol: string;
  side: string;
  orderType: string;
  quantity: number;
  price?: number;
  notionalEstimated: number;
  filters: BinanceFuturesExchangeInfoSymbolFilter[];
};

export type FuturesOrderValidatorTelemetry = {
  symbol: string;
  side: string;
  orderType: string;
  rawQuantity: number;
  normalizedQuantity: number | null;
  rawPrice: number | null;
  normalizedPrice: number | null;
  rawNotionalEstimated: number;
  normalizedNotionalEstimated: number | null;
  tickSize: number | null;
  stepSize: number | null;
  minQty: number | null;
  maxQty: number | null;
  minNotional: number | null;
  quantityRoundedDown: boolean;
  priceRoundedDown: boolean;
};

export type FuturesOrderValidatorResult = {
  ok: boolean;
  normalizedQuantity: number | null;
  normalizedPrice: number | null;
  reasons: string[];
  telemetry: FuturesOrderValidatorTelemetry;
};

type ParsedFilters = {
  tickSize: number | null;
  stepSize: number | null;
  minQty: number | null;
  maxQty: number | null;
  minNotional: number | null;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimalPlaces(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  const text = value.toString();
  if (!text.includes("e")) {
    const parts = text.split(".");
    return parts[1]?.replace(/0+$/, "").length ?? 0;
  }
  const parts = text.split("e");
  const mantissa = parts[0] ?? "0";
  const exponent = Number(parts[1] ?? "0");
  const mantissaDecimals = (mantissa.split(".")[1] ?? "").length;
  return Math.max(0, mantissaDecimals - exponent);
}

function roundDownToStep(value: number, step: number | null): number {
  if (step === null || !Number.isFinite(step) || step <= 0) return value;
  const precision = decimalPlaces(step);
  const scaled = Math.floor((value + 1e-12) / step) * step;
  return Number(scaled.toFixed(Math.min(precision, 16)));
}

function normalizePriceToTick(value: number, tickSize: number | null): number {
  if (tickSize === null || !Number.isFinite(tickSize) || tickSize <= 0) return value;
  const precision = decimalPlaces(tickSize);
  const scaled = Math.floor((value + 1e-12) / tickSize) * tickSize;
  return Number(scaled.toFixed(Math.min(precision, 16)));
}

function extractFilters(filters: BinanceFuturesExchangeInfoSymbolFilter[]): ParsedFilters {
  const priceFilter = filters.find((f) => f.filterType === "PRICE_FILTER");
  const lotSizeFilter = filters.find((f) => f.filterType === "LOT_SIZE");
  const marketLotSizeFilter = filters.find((f) => f.filterType === "MARKET_LOT_SIZE");
  const notionalFilter = filters.find(
    (f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL"
  );

  return {
    tickSize: parseNumber(priceFilter?.tickSize),
    stepSize: parseNumber(lotSizeFilter?.stepSize ?? marketLotSizeFilter?.stepSize),
    minQty: parseNumber(lotSizeFilter?.minQty ?? marketLotSizeFilter?.minQty),
    maxQty: parseNumber(lotSizeFilter?.maxQty ?? marketLotSizeFilter?.maxQty),
    minNotional: parseNumber(notionalFilter?.minNotional ?? notionalFilter?.notional),
  };
}

function pushIf(condition: boolean, reasons: string[], reason: string): void {
  if (condition) reasons.push(reason);
}

export function validateFuturesOrder(
  input: FuturesOrderValidatorInput
): FuturesOrderValidatorResult {
  const reasons: string[] = [];
  const symbol = input.symbol.trim().toUpperCase();
  const side = input.side.trim().toUpperCase();
  const orderType = input.orderType.trim().toUpperCase();
  const filters = extractFilters(input.filters);

  pushIf(!symbol, reasons, "symbol_required");
  pushIf(!isFiniteNumber(input.quantity) || input.quantity <= 0, reasons, "quantity_invalid");
  pushIf(
    !isFiniteNumber(input.notionalEstimated) || input.notionalEstimated <= 0,
    reasons,
    "notional_estimated_invalid"
  );

  if (side !== "BUY" && side !== "SELL") {
    reasons.push("side_invalid");
  }
  if (orderType !== "MARKET" && orderType !== "LIMIT") {
    reasons.push("order_type_invalid");
  }

  if (input.price !== undefined && !isFiniteNumber(input.price)) {
    reasons.push("price_invalid");
  }

  const normalizedQuantity = isFiniteNumber(input.quantity)
    ? roundDownToStep(input.quantity, filters.stepSize)
    : null;
  const normalizedPrice =
    input.price !== undefined && isFiniteNumber(input.price)
      ? normalizePriceToTick(input.price, filters.tickSize)
      : null;
  const normalizedNotionalEstimated =
    normalizedQuantity !== null
      ? normalizedPrice !== null
        ? normalizedQuantity * normalizedPrice
        : input.notionalEstimated
      : null;

  const quantityRoundedDown =
    normalizedQuantity !== null &&
    isFiniteNumber(input.quantity) &&
    normalizedQuantity < input.quantity;
  const priceRoundedDown =
    normalizedPrice !== null &&
    input.price !== undefined &&
    isFiniteNumber(input.price) &&
    normalizedPrice < input.price;

  if (normalizedQuantity !== null && filters.minQty !== null && normalizedQuantity < filters.minQty) {
    reasons.push("quantity_below_min_qty");
  }
  if (normalizedQuantity !== null && filters.maxQty !== null && normalizedQuantity > filters.maxQty) {
    reasons.push("quantity_above_max_qty");
  }
  if (
    normalizedNotionalEstimated !== null &&
    filters.minNotional !== null &&
    normalizedNotionalEstimated < filters.minNotional
  ) {
    reasons.push("notional_below_min_notional");
  }

  const ok = reasons.length === 0;
  return {
    ok,
    normalizedQuantity,
    normalizedPrice,
    reasons,
    telemetry: {
      symbol,
      side,
      orderType,
      rawQuantity: input.quantity,
      normalizedQuantity,
      rawPrice: input.price ?? null,
      normalizedPrice,
      rawNotionalEstimated: input.notionalEstimated,
      normalizedNotionalEstimated,
      tickSize: filters.tickSize,
      stepSize: filters.stepSize,
      minQty: filters.minQty,
      maxQty: filters.maxQty,
      minNotional: filters.minNotional,
      quantityRoundedDown,
      priceRoundedDown,
    },
  };
}
