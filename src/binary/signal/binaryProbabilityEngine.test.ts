import { describe, expect, it } from "vitest";

import {
  getBinaryProbability,
  getBinaryProbabilityDiagnostics,
  pricesToProbabilityTicks,
} from "./binaryProbabilityEngine.js";

const baseCtx = {
  windowSize: 5,
  timeHorizonMs: 30_000,
  sigmoidK: 4,
};

describe("binaryProbabilityEngine", () => {
  it("pricesToProbabilityTicks assigns monotone time with newest last", () => {
    const t0 = 1_000_000;
    const ticks = pricesToProbabilityTicks([100, 101, 102], t0, 5000);
    expect(ticks.map((x) => x.timeMs)).toEqual([990_000, 995_000, 1_000_000]);
    expect(ticks.map((x) => x.price)).toEqual([100, 101, 102]);
  });

  it("returns 0.5 when fewer than two ticks", () => {
    const d = getBinaryProbabilityDiagnostics({
      ...baseCtx,
      ticks: [{ price: 1, timeMs: 0 }],
    });
    expect(d.ok).toBe(false);
    expect(d.up).toBe(0.5);
    expect(d.down).toBe(0.5);
    expect(getBinaryProbability({ ...baseCtx, ticks: [] })).toEqual({
      up: 0.5,
      down: 0.5,
    });
  });

  it("uptrend yields probability_up > 0.5", () => {
    const prices = [50_000, 50_010, 50_020, 50_030, 50_040];
    const ticks = pricesToProbabilityTicks(prices, 200_000, 5000);
    const d = getBinaryProbabilityDiagnostics({ ...baseCtx, ticks });
    expect(d.ok).toBe(true);
    expect(d.momentum).toBeGreaterThan(0);
    expect(d.up).toBeGreaterThan(0.5);
    expect(d.down).toBeLessThan(0.5);
    expect(getBinaryProbability({ ...baseCtx, ticks }).up).toBe(d.up);
    expect(getBinaryProbability({ ...baseCtx, ticks }).down).toBe(d.down);
    expect(d.up + d.down).toBeCloseTo(1, 5);
  });

  it("downtrend yields probability_up < 0.5", () => {
    const prices = [50_040, 50_030, 50_020, 50_010, 50_000];
    const ticks = pricesToProbabilityTicks(prices, 200_000, 5000);
    const d = getBinaryProbabilityDiagnostics({ ...baseCtx, ticks });
    expect(d.ok).toBe(true);
    expect(d.momentum).toBeLessThan(0);
    expect(d.up).toBeLessThan(0.5);
  });

  it("flat series stays near 0.5", () => {
    const prices = Array.from({ length: 10 }, () => 50_000);
    const ticks = pricesToProbabilityTicks(prices, 500_000, 5000);
    const d = getBinaryProbabilityDiagnostics({
      ...baseCtx,
      ticks,
      windowSize: 10,
    });
    expect(d.ok).toBe(true);
    expect(d.momentum).toBe(0);
    expect(d.up).toBeCloseTo(0.5, 1);
  });

  it("is deterministic for identical input", () => {
    const ticks = pricesToProbabilityTicks(
      [100, 101, 100.5, 100.8],
      1_234_567,
      2000
    );
    const a = getBinaryProbabilityDiagnostics({
      ticks,
      windowSize: 4,
      timeHorizonMs: 15_000,
      sigmoidK: 3.5,
    });
    const b = getBinaryProbabilityDiagnostics({
      ticks,
      windowSize: 4,
      timeHorizonMs: 15_000,
      sigmoidK: 3.5,
    });
    expect(a).toEqual(b);
  });
});
