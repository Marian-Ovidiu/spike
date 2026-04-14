import { describe, expect, it } from "vitest";
import {
  detectContextualSpike,
  detectSpike,
  detectStableRange,
  detectStableRangePriorToLast,
  detectWindowSpike,
  isMoveDominantVsChop,
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

describe("detectWindowSpike", () => {
  it("returns not-detected for single price", () => {
    const r = detectWindowSpike([100], 0.01);
    expect(r.detected).toBe(false);
    expect(r.classification).toBe("no_signal");
    expect(r.comparisons).toHaveLength(0);
  });

  it("detects spike via tick-1 (same as old single-tick)", () => {
    const r = detectWindowSpike([100, 102], 0.01);
    expect(r.detected).toBe(true);
    expect(r.classification).toBe("strong_spike");
    expect(r.source).toBe("tick-1");
    expect(r.direction).toBe("up");
    expect(r.strongestMove).toBeCloseTo(0.02, 6);
    expect(r.strongestMoveDirection).toBe("UP");
  });

  it("detects gradual move that tick-1 misses but tick-3 catches", () => {
    const prices = [100_000, 100_200, 100_400, 100_600];
    const r = detectWindowSpike(prices, 0.005);
    expect(r.detected).toBe(true);
    expect(r.classification).toBe("strong_spike");
    expect(r.source).toBe("tick-3");
    expect(r.referencePrice).toBe(100_000);
    expect(r.strongestMove).toBeCloseTo(0.006, 4);
    expect(r.direction).toBe("up");
  });

  it("includes tick-1, tick-2, tick-3 comparisons", () => {
    const prices = [100, 101, 102, 103];
    const r = detectWindowSpike(prices, 0.05);
    expect(r.comparisons).toHaveLength(3);
    expect(r.comparisons.map((c) => c.source)).toEqual([
      "tick-1",
      "tick-2",
      "tick-3",
    ]);
  });

  it("adds window-oldest when it differs from tick candidates", () => {
    const prices = [90, 95, 100, 101, 102, 103];
    const r = detectWindowSpike(prices, 0.05, 5);
    const sources = r.comparisons.map((c) => c.source);
    expect(sources).toContain("window-oldest");
  });

  it("returns correct direction for downward spike", () => {
    const r = detectWindowSpike([100, 97], 0.01);
    expect(r.detected).toBe(true);
    expect(r.direction).toBe("down");
  });

  it("returns null direction when current equals reference", () => {
    const r = detectWindowSpike([100, 100], 0.0);
    expect(r.direction).toBeNull();
  });

  it("classifies near-threshold move as borderline", () => {
    const r = detectWindowSpike([100, 100.093], 0.001, 2, 0.85);
    expect(r.detected).toBe(false);
    expect(r.classification).toBe("borderline");
    expect(r.thresholdRatio).toBeCloseTo(0.93, 2);
    expect(r.strongestMoveDirection).toBe("UP");
    expect(r.sourceWindowLabel).toBe("tick-1");
  });

  it("classifies move below borderline ratio as no_signal", () => {
    const r = detectWindowSpike([100, 100.07], 0.001, 2, 0.85);
    expect(r.detected).toBe(false);
    expect(r.classification).toBe("no_signal");
    expect(r.thresholdRatio).toBeCloseTo(0.7, 2);
  });

  it("classifies move above full threshold as strong_spike", () => {
    const r = detectWindowSpike([100, 100.12], 0.001, 2, 0.85);
    expect(r.detected).toBe(true);
    expect(r.classification).toBe("strong_spike");
    expect(r.thresholdRatio).toBeCloseTo(1.2, 2);
  });
});

describe("isMoveDominantVsChop", () => {
  it("returns true when move dominates prior chop", () => {
    const prior = [100, 100.1, 99.9, 100.05];
    expect(isMoveDominantVsChop(0.02, prior, 2, 0.001)).toBe(true);
  });

  it("returns false when move is marginal vs prior chop", () => {
    const prior = [100, 101, 99.5, 100.2];
    expect(isMoveDominantVsChop(0.003, prior, 5, 0.001)).toBe(false);
  });

  it("falls back to threshold check with < 2 prior prices", () => {
    expect(isMoveDominantVsChop(0.006, [100], 2, 0.005)).toBe(true);
    expect(isMoveDominantVsChop(0.004, [100], 2, 0.005)).toBe(false);
  });

  it("falls back to threshold check when rangeSpan is zero", () => {
    expect(isMoveDominantVsChop(0.006, [100, 100, 100], 2, 0.005)).toBe(true);
    expect(isMoveDominantVsChop(0.004, [100, 100, 100], 2, 0.005)).toBe(false);
  });
});
