import { describe, expect, it } from "vitest";
import {
  detectSpike,
  detectStableRange,
  detectStableRangePriorToLast,
  detectWindowSpike,
  isMoveDominantVsChop,
} from "./spikeDetection.js";

describe("core/signal spikeDetection", () => {
  it("detectStableRange: strict span vs threshold", () => {
    expect(detectStableRange([], 0.01)).toBe(false);
    expect(detectStableRange([42_000], 0.01)).toBe(true);
    expect(detectStableRange([100, 101, 100.5], 0.02)).toBe(true);
    expect(detectStableRange([100, 120], 0.1)).toBe(false);
  });

  it("detectSpike: relative move vs threshold", () => {
    expect(detectSpike(100, 102, 0.01)).toBe(true);
    expect(detectSpike(100, 100.5, 0.01)).toBe(false);
    expect(detectSpike(0, 100, 0.01)).toBe(false);
  });

  it("detectWindowSpike: maps impulse to neutral directions", () => {
    const r = detectWindowSpike([100, 100.1, 100.05, 150], 0.01);
    expect(r.impulseDirection).toBe("up");
    expect(r.band).toBe("strong_spike");
  });

  it("isMoveDominantVsChop: falls back when prior window too short", () => {
    expect(isMoveDominantVsChop(0.02, [], 2, 0.01)).toBe(true);
  });
});
