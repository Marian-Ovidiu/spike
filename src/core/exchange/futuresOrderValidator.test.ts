import { describe, expect, it } from "vitest";
import type { BinanceFuturesExchangeInfoSymbolFilter } from "./binanceFuturesClient.js";
import { validateFuturesOrder } from "./futuresOrderValidator.js";

const btcFilters: BinanceFuturesExchangeInfoSymbolFilter[] = [
  {
    filterType: "PRICE_FILTER",
    minPrice: "0.10",
    maxPrice: "1000000.00",
    tickSize: "0.10",
  },
  {
    filterType: "LOT_SIZE",
    minQty: "0.001",
    maxQty: "1000.000",
    stepSize: "0.001",
  },
  {
    filterType: "MIN_NOTIONAL",
    notional: "5",
  },
];

describe("validateFuturesOrder", () => {
  it("normalizes quantity and price down to exchange increments", () => {
    const res = validateFuturesOrder({
      symbol: "btcusdt",
      side: "buy",
      orderType: "limit",
      quantity: 0.12349,
      price: 65001.279,
      notionalEstimated: 8020.1,
      filters: btcFilters,
    });

    expect(res.ok).toBe(true);
    expect(res.normalizedQuantity).toBeCloseTo(0.123, 12);
    expect(res.normalizedPrice).toBeCloseTo(65001.2, 12);
    expect(res.reasons).toEqual([]);
    expect(res.telemetry.quantityRoundedDown).toBe(true);
    expect(res.telemetry.priceRoundedDown).toBe(true);
    expect(res.telemetry.rawQuantity).toBe(0.12349);
    expect(res.telemetry.normalizedQuantity).toBeCloseTo(0.123, 12);
  });

  it("rejects quantity below minQty after normalization", () => {
    const res = validateFuturesOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 0.0009,
      price: 65000,
      notionalEstimated: 58.5,
      filters: btcFilters,
    });

    expect(res.ok).toBe(false);
    expect(res.reasons).toContain("quantity_below_min_qty");
  });

  it("rejects quantity above maxQty", () => {
    const res = validateFuturesOrder({
      symbol: "BTCUSDT",
      side: "SELL",
      orderType: "LIMIT",
      quantity: 1000.001,
      price: 65000,
      notionalEstimated: 65000065,
      filters: btcFilters,
    });

    expect(res.ok).toBe(false);
    expect(res.reasons).toContain("quantity_above_max_qty");
  });

  it("rejects notional below minNotional when present", () => {
    const res = validateFuturesOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      orderType: "MARKET",
      quantity: 0.001,
      notionalEstimated: 4.99,
      filters: btcFilters,
    });

    expect(res.ok).toBe(false);
    expect(res.reasons).toContain("notional_below_min_notional");
  });

  it("rejects invalid side and order type", () => {
    const res = validateFuturesOrder({
      symbol: "BTCUSDT",
      side: "HOLD",
      orderType: "STOP",
      quantity: 0.01,
      price: 65000,
      notionalEstimated: 650,
      filters: btcFilters,
    });

    expect(res.ok).toBe(false);
    expect(res.reasons).toEqual(
      expect.arrayContaining(["side_invalid", "order_type_invalid"])
    );
  });

  it("supports filters without minNotional", () => {
    const res = validateFuturesOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      orderType: "MARKET",
      quantity: 0.0049,
      notionalEstimated: 320,
      filters: [
        {
          filterType: "PRICE_FILTER",
          tickSize: "0.1",
        },
        {
          filterType: "LOT_SIZE",
          minQty: "0.001",
          stepSize: "0.001",
        },
      ],
    });

    expect(res.ok).toBe(true);
    expect(res.normalizedQuantity).toBeCloseTo(0.004, 12);
    expect(res.normalizedPrice).toBeNull();
    expect(res.reasons).toEqual([]);
  });
});

