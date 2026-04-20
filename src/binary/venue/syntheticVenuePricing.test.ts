import { describe, expect, it } from "vitest";

import {
  SyntheticVenuePricingEngine,
  syntheticVenueNoiseUnit,
} from "./syntheticVenuePricing.js";

describe("syntheticVenueNoiseUnit", () => {
  it("is deterministic for tick + seed", () => {
    expect(syntheticVenueNoiseUnit(42, 0xabc)).toBe(syntheticVenueNoiseUnit(42, 0xabc));
    expect(syntheticVenueNoiseUnit(42, 0xabc)).not.toBe(syntheticVenueNoiseUnit(43, 0xabc));
  });
});

describe("SyntheticVenuePricingEngine", () => {
  it("with identity settings tracks fair in one step from published mid", () => {
    const e = new SyntheticVenuePricingEngine({
      lagTicks: 0,
      reactionAlpha: 1,
      noiseBps: 0,
      biasBps: 0,
      seed: 1,
    });
    e.primeFairHistory(0.5);
    const s = e.step(0.8, 1, 0.5);
    expect(s.rawVenueYesMid).toBeCloseTo(0.8, 6);
    expect(s.laggedFairValueYes).toBeCloseTo(0.8, 6);
  });

  it("lags fair value by lagTicks", () => {
    const e = new SyntheticVenuePricingEngine({
      lagTicks: 1,
      reactionAlpha: 1,
      noiseBps: 0,
      biasBps: 0,
      seed: 0,
    });
    e.clearFairHistory();
    const s1 = e.step(0.9, 1, 0.5);
    expect(s1.laggedFairValueYes).toBeCloseTo(0.9, 6);
    const s2 = e.step(0.1, 2, s1.rawVenueYesMid);
    expect(s2.laggedFairValueYes).toBeCloseTo(0.9, 6);
    expect(s2.fairValueYes).toBeCloseTo(0.1, 6);
  });

  it("applies bias in bps to lagged fair", () => {
    const e = new SyntheticVenuePricingEngine({
      lagTicks: 0,
      reactionAlpha: 1,
      noiseBps: 0,
      biasBps: 100,
      seed: 0,
    });
    e.primeFairHistory(0.5);
    const s = e.step(0.5, 1, 0.5);
    expect(s.biasedFairValueYes).toBeCloseTo(0.51, 6);
  });
});
