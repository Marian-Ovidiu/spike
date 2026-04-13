import { describe, expect, it } from "vitest";
import {
  detectContextualSpike,
  detectSpike,
  detectStableRange,
  detectStableRangePriorToLast,
} from "./strategy.js";

describe("detectStableRange", () => {
  it("returns false for empty input", () => {
    expect(detectStableRange([], 0.01)).toBe(false);
  });

  it("returns true for a single positive price (span is zero)", () => {
    expect(detectStableRange([42_000], 0.01)).toBe(true);
  });

  it("returns true when relative span is strictly below threshold", () => {
    // max=101, min=100 → (101-100)/100 = 0.01
    expect(detectStableRange([100, 101, 100.5], 0.02)).toBe(true);
  });

  it("returns false when relative span exceeds threshold", () => {
    // (120-100)/100 = 0.2
    expect(detectStableRange([100, 120], 0.1)).toBe(false);
  });

  it("returns false when relative span equals threshold (strict <)", () => {
    // (101-100)/100 = 0.01, not < 0.01
    expect(detectStableRange([100, 101], 0.01)).toBe(false);
  });

  it("returns false when min is not positive", () => {
    expect(detectStableRange([0, 1, 2], 0.5)).toBe(false);
    expect(detectStableRange([-1, 100, 101], 0.5)).toBe(false);
  });
});

describe("detectSpike", () => {
  const threshold = 0.01; // 1% relative move

  it("returns true on upward move above threshold", () => {
    // 100 → 102 : 2% > 1%
    expect(detectSpike(100, 102, threshold)).toBe(true);
  });

  it("returns true on downward move above threshold", () => {
    // 100 → 98 : 2% > 1%
    expect(detectSpike(100, 98, threshold)).toBe(true);
  });

  it("returns false when relative change is below threshold", () => {
    // 100 → 100.5 : 0.5% < 1%
    expect(detectSpike(100, 100.5, threshold)).toBe(false);
  });

  it("returns false when relative change equals threshold (strict >)", () => {
    // 100 → 101 : exactly 1%
    expect(detectSpike(100, 101, threshold)).toBe(false);
  });

  it("returns false when previous price is not positive or not finite", () => {
    expect(detectSpike(0, 100, threshold)).toBe(false);
    expect(detectSpike(-10, 11, threshold)).toBe(false);
    expect(detectSpike(Number.NaN, 100, threshold)).toBe(false);
  });

  it("returns false when current price is not finite", () => {
    expect(detectSpike(100, Number.NaN, threshold)).toBe(false);
  });
});

describe("detectStableRangePriorToLast", () => {
  it("ignores last tick when judging stability", () => {
    const prices = [100, 100.1, 100.05, 150];
    expect(detectStableRange(prices, 0.02)).toBe(false);
    expect(detectStableRangePriorToLast(prices, 0.02)).toBe(true);
  });
});

describe("detectContextualSpike", () => {
  it("requires spike to dominate prior range when multiple is set", () => {
    const prior = [100, 100.2, 99.9, 100.1];
    expect(
      detectContextualSpike(100.1, 100.25, 0.001, prior, 2)
    ).toBe(false);
    expect(
      detectContextualSpike(100.1, 102, 0.001, prior, 2)
    ).toBe(true);
  });
});
