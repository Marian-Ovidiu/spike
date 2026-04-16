import { describe, expect, it } from "vitest";
import { resolveQualityStakeMultiplier } from "./stakeSizing.js";

const base = {
  allowWeakQualityEntries: false,
  weakQualitySizeMultiplier: 0.5,
  strongQualitySizeMultiplier: 1,
  exceptionalQualitySizeMultiplier: 1,
} as const;

describe("resolveQualityStakeMultiplier", () => {
  it("returns 1 when allowWeakQualityEntries is false (default behavior)", () => {
    expect(resolveQualityStakeMultiplier("weak", base)).toBe(1);
    expect(resolveQualityStakeMultiplier("strong", base)).toBe(1);
    expect(resolveQualityStakeMultiplier("exceptional", base)).toBe(1);
  });

  it("scales by profile when allowWeakQualityEntries is true", () => {
    const on = { ...base, allowWeakQualityEntries: true };
    expect(resolveQualityStakeMultiplier("weak", on)).toBe(0.5);
    expect(resolveQualityStakeMultiplier("strong", on)).toBe(1);
    expect(resolveQualityStakeMultiplier("acceptable", on)).toBe(1);
    expect(resolveQualityStakeMultiplier("exceptional", on)).toBe(1);
  });
});
