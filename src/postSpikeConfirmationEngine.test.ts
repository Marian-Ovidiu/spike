import { describe, expect, it } from "vitest";
import { analyzePostSpikeConfirmation } from "./postSpikeConfirmationEngine.js";

describe("postSpikeConfirmationEngine", () => {
  it("classifies continuation", () => {
    const out = analyzePostSpikeConfirmation({
      originalDirection: "UP",
      detectionPrice: 100_000,
      originalAbsMove: 100,
      watchedTickPrices: [100_030],
      continuationThreshold: 0.25,
      reversionThreshold: 0.2,
      pauseBandPercent: 0.00015,
    });
    expect(out.postMoveClassification).toBe("continuation");
  });

  it("classifies reversion", () => {
    const out = analyzePostSpikeConfirmation({
      originalDirection: "UP",
      detectionPrice: 100_000,
      originalAbsMove: 100,
      watchedTickPrices: [99_975],
      continuationThreshold: 0.25,
      reversionThreshold: 0.2,
      pauseBandPercent: 0.00015,
    });
    expect(out.postMoveClassification).toBe("reversion");
  });

  it("classifies pause", () => {
    const out = analyzePostSpikeConfirmation({
      originalDirection: "UP",
      detectionPrice: 100_000,
      originalAbsMove: 100,
      watchedTickPrices: [100_010],
      continuationThreshold: 0.25,
      reversionThreshold: 0.2,
      pauseBandPercent: 0.0002,
    });
    expect(out.postMoveClassification).toBe("pause");
  });

  it("classifies noisy_unclear", () => {
    const out = analyzePostSpikeConfirmation({
      originalDirection: "UP",
      detectionPrice: 100_000,
      originalAbsMove: 100,
      watchedTickPrices: [100_015, 99_990],
      continuationThreshold: 0.6,
      reversionThreshold: 0.6,
      pauseBandPercent: 0.00005,
    });
    expect(out.postMoveClassification).toBe("noisy_unclear");
  });
});

