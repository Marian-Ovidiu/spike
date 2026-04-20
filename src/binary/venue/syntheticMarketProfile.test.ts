import { afterEach, describe, expect, it, vi } from "vitest";

import { SyntheticVenuePricingEngine } from "./syntheticVenuePricing.js";
import { SyntheticBinaryMarket } from "./syntheticBinaryMarket.js";

describe("syntheticMarketProfile", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("applies balanced profile defaults when SYNTHETIC_MARKET_PROFILE is set", () => {
    vi.stubEnv("SYNTHETIC_MARKET_PROFILE", "balanced");
    vi.stubEnv("SYNTHETIC_MARKET_LAG_TICKS", "");
    vi.stubEnv("SYNTHETIC_MARKET_REACTION_ALPHA", "");
    vi.stubEnv("SYNTHETIC_MARKET_NOISE_BPS", "");
    vi.stubEnv("SYNTHETIC_MARKET_BIAS_BPS", "");
    const o = SyntheticVenuePricingEngine.optionsFromEnv();
    expect(o.lagTicks).toBe(2);
    expect(o.reactionAlpha).toBeCloseTo(0.42, 6);
    expect(o.noiseBps).toBe(16);
    expect(o.biasBps).toBe(0);
  });

  it("lets explicit env override profile defaults", () => {
    vi.stubEnv("SYNTHETIC_MARKET_PROFILE", "slow");
    vi.stubEnv("SYNTHETIC_MARKET_REACTION_ALPHA", "0.99");
    const o = SyntheticVenuePricingEngine.optionsFromEnv();
    expect(o.lagTicks).toBe(10);
    expect(o.reactionAlpha).toBe(0.99);
  });

  it("merges market tuning from reactive profile into optionsFromEnv", () => {
    vi.stubEnv("SYNTHETIC_MARKET_PROFILE", "reactive");
    vi.stubEnv("SYNTHETIC_SPREAD_BPS", "");
    vi.stubEnv("BINARY_SYNTHETIC_SPREAD_BPS", "");
    vi.stubEnv("SYNTHETIC_MARKET_MAX_SPREAD_BPS", "");
    vi.stubEnv("SYNTHETIC_SLIPPAGE_BPS", "");
    vi.stubEnv("SYNTHETIC_MID_SMOOTH_NEW_WEIGHT", "");
    const m = SyntheticBinaryMarket.optionsFromEnv();
    expect(m.spreadBps).toBe(24);
    expect(m.slippageBps).toBe(4);
    expect(m.midSmoothNewWeight).toBeCloseTo(0.42, 6);
  });
});
