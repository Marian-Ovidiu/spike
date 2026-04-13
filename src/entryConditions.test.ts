import { describe, expect, it } from "vitest";
import {
  ENTRY_REASON_CODES,
  evaluateEntryConditions,
} from "./entryConditions.js";

/** Consistent buffers: last = currentPrice, second-last = previousPrice. */
const base = {
  rangeThreshold: 0.02,
  spikeThreshold: 0.01,
  spikeMinRangeMultiple: 2.2,
  entryPrice: 0.4,
  upSidePrice: 0.35,
  downSidePrice: 0.3,
};

describe("evaluateEntryConditions", () => {
  it("returns null when prior window is not stable", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 125, 130],
      previousPrice: 125,
      currentPrice: 130,
      rangeThreshold: 0.001,
    });
    expect(r.direction).toBeNull();
    expect(r.shouldEnter).toBe(false);
    expect(r.reasons).toContain(ENTRY_REASON_CODES.MARKET_NOT_STABLE);
  });

  it("returns null direction when no spike", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.1, 100.05, 100.08, 100.09],
      previousPrice: 100.08,
      currentPrice: 100.09,
      spikeThreshold: 0.01,
    });
    expect(r.direction).toBeNull();
    expect(r.shouldEnter).toBe(false);
    expect(r.reasons).toContain(ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH);
  });

  it("spike up: direction DOWN, shouldEnter when down side < entryPrice", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.1, 100.05, 100.08, 105],
      previousPrice: 100.08,
      currentPrice: 105,
      downSidePrice: 0.2,
      entryPrice: 0.25,
    });
    expect(r.direction).toBe("DOWN");
    expect(r.shouldEnter).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("spike up: shouldEnter false when down side >= entryPrice", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.1, 100.05, 100.08, 105],
      previousPrice: 100.08,
      currentPrice: 105,
      downSidePrice: 0.5,
      entryPrice: 0.25,
    });
    expect(r.direction).toBe("DOWN");
    expect(r.shouldEnter).toBe(false);
    expect(r.reasons).toEqual([
      ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH,
    ]);
  });

  it("spike down: direction UP, shouldEnter when up side < entryPrice", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.1, 100.05, 100.08, 94],
      previousPrice: 100.08,
      currentPrice: 94,
      upSidePrice: 0.2,
      entryPrice: 0.25,
    });
    expect(r.direction).toBe("UP");
    expect(r.shouldEnter).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("spike down: shouldEnter false when up side >= entryPrice", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.1, 100.05, 100.08, 94],
      previousPrice: 100.08,
      currentPrice: 94,
      upSidePrice: 0.5,
      entryPrice: 0.25,
    });
    expect(r.direction).toBe("UP");
    expect(r.shouldEnter).toBe(false);
    expect(r.reasons).toEqual([
      ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH,
    ]);
  });

  it("returns null when previous equals current", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.1, 100.05, 100, 100],
      previousPrice: 100,
      currentPrice: 100,
      spikeThreshold: 0,
    });
    expect(r.direction).toBeNull();
    expect(r.shouldEnter).toBe(false);
    expect(r.reasons).toContain(ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH);
  });

  it("rejects marginal spike vs chop when multiple is high", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 101, 99.5, 100.2, 100.45],
      previousPrice: 100.2,
      currentPrice: 100.45,
      rangeThreshold: 0.02,
      spikeThreshold: 0.002,
      spikeMinRangeMultiple: 5,
    });
    expect(r.shouldEnter).toBe(false);
    expect(r.reasons).toContain(ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH);
  });

  it("rejects invalid market prices", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.1, 100.05, 100.08, 105],
      previousPrice: 100.08,
      currentPrice: 105,
      upSidePrice: Number.NaN,
      downSidePrice: 0.2,
      entryPrice: 0.25,
    });
    expect(r.shouldEnter).toBe(false);
    expect(r.reasons).toEqual([ENTRY_REASON_CODES.INVALID_MARKET_PRICES]);
  });
});
