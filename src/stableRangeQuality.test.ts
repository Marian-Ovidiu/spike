import { describe, expect, it } from "vitest";

import { assessStableRangeQuality } from "./stableRangeQuality.js";

describe("assessStableRangeQuality", () => {
  it("returns priorRangeFraction as (max−min)/min on the prior window", () => {
    const prices = [100_000, 100_100, 100_260];
    const out = assessStableRangeQuality({
      prices,
      rangeThreshold: 0.02,
      stableRangeSoftToleranceRatio: 1.5,
    });
    expect(out.priorRangeFraction).toBeCloseTo(0.001, 10);
  });

  it("0.0016 relative range is 0.16% when expressed as percent points", () => {
    const f = 0.0016;
    expect(f * 100).toBeCloseTo(0.16, 10);
  });
});
