import { describe, expect, it } from "vitest";
import {
  ENTRY_REASON_CODES,
  evaluateEntryConditions,
} from "./entryConditions.js";

/** Consistent buffers: last = currentPrice, second-last = previousPrice. */
const base = {
  rangeThreshold: 0.02,
  stableRangeSoftToleranceRatio: 1.5,
  strongSpikeHardRejectPoorRange: false,
  spikeThreshold: 0.01,
  spikeMinRangeMultiple: 2.2,
  borderlineMinRatio: 0.85,
  entryPrice: 0.4,
  maxOppositeSideEntryPrice: 0.35,
  neutralQuoteBandMin: 0.45,
  neutralQuoteBandMax: 0.55,
  upSidePrice: 0.35,
  downSidePrice: 0.3,
};

describe("evaluateEntryConditions", () => {
  it("strong spike uses priority path even when strict range fails", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 125, 130],
      previousPrice: 125,
      currentPrice: 130,
      rangeThreshold: 0.001,
    });
    expect(r.direction).toBe("DOWN");
    expect(r.shouldEnter).toBe(true);
    expect(r.stableRangeDetected).toBe(false);
    expect(r.stableRangeQuality).toBe("poor");
    expect(r.reasons).toEqual([]);
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
    expect(r.windowSpike?.classification).toBe("no_signal");
  });

  it("allows strong spike with acceptable (soft) pre-range quality", () => {
    const r = evaluateEntryConditions({
      ...base,
      rangeThreshold: 0.01,
      stableRangeSoftToleranceRatio: 1.5,
      prices: [100, 100.9, 100.7, 100.8, 102.6],
      previousPrice: 100.8,
      currentPrice: 102.6,
      spikeThreshold: 0.01,
      spikeMinRangeMultiple: 1.2,
      downSidePrice: 0.2,
      entryPrice: 0.25,
    });
    expect(r.shouldEnter).toBe(true);
    expect(r.stableRangeQuality).toBe("acceptable");
  });

  it("sets strong_spike with spikeDetected=true above threshold", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.05, 100.1, 100.12, 101.5],
      previousPrice: 100.12,
      currentPrice: 101.5,
      spikeThreshold: 0.01,
      spikeMinRangeMultiple: 1.0,
      downSidePrice: 0.2,
      entryPrice: 0.25,
    });
    expect(r.movementClassification).toBe("strong_spike");
    expect(r.spikeDetected).toBe(true);
    expect(r.movement.classification).toBe("strong_spike");
    expect(r.movement.strongestMovePercent).toBeCloseTo(
      r.windowSpike!.strongestMovePercent,
      10
    );
  });

  it("movement classification exact threshold crossing is strong_spike", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.01],
      previousPrice: 100,
      currentPrice: 100.01,
      spikeThreshold: 0.0001,
      spikeMinRangeMultiple: 1,
    });
    expect(r.movement.classification).toBe("strong_spike");
    expect(r.spikeDetected).toBe(true);
  });

  it("movement classification above threshold is strong_spike", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.02],
      previousPrice: 100,
      currentPrice: 100.02,
      spikeThreshold: 0.0001,
      spikeMinRangeMultiple: 1,
    });
    expect(r.movement.classification).toBe("strong_spike");
    expect(r.spikeDetected).toBe(true);
  });

  it("movement classification below threshold but above borderline is borderline", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.093],
      previousPrice: 100,
      currentPrice: 100.093,
      spikeThreshold: 0.001,
      borderlineMinRatio: 0.85,
      spikeMinRangeMultiple: 1.5,
    });
    expect(r.movement.classification).toBe("borderline");
    expect(r.spikeDetected).toBe(false);
  });

  it("movement classification below borderline is no_signal", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.03],
      previousPrice: 100,
      currentPrice: 100.03,
      spikeThreshold: 0.001,
      borderlineMinRatio: 0.85,
      spikeMinRangeMultiple: 1.5,
    });
    expect(r.movement.classification).toBe("no_signal");
    expect(r.spikeDetected).toBe(false);
  });

  it("strong spike bypasses strict stable-range rejection when hard reject is off", () => {
    const r = evaluateEntryConditions({
      ...base,
      rangeThreshold: 0.001,
      stableRangeSoftToleranceRatio: 1.5,
      strongSpikeHardRejectPoorRange: false,
      prices: [100, 120, 118, 119, 130],
      previousPrice: 119,
      currentPrice: 130,
      spikeThreshold: 0.05,
      spikeMinRangeMultiple: 1.0,
      downSidePrice: 0.2,
      entryPrice: 0.25,
    });
    expect(r.movementClassification).toBe("strong_spike");
    expect(r.spikeDetected).toBe(true);
    expect(r.shouldEnter).toBe(true);
    expect(r.reasons).not.toContain(ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH);
  });

  it("classifies near-threshold move as borderline", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.02, 100.01, 100.00, 100.093],
      previousPrice: 100.0,
      currentPrice: 100.093,
      spikeThreshold: 0.001,
      borderlineMinRatio: 0.85,
      spikeMinRangeMultiple: 2.2,
    });
    expect(r.shouldEnter).toBe(false);
    expect(r.reasons).toContain(ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH);
    expect(r.windowSpike?.classification).toBe("borderline");
    expect(r.windowSpike?.thresholdRatio).toBeGreaterThanOrEqual(0.85);
    expect(r.windowSpike?.thresholdRatio).toBeLessThan(1);
  });

  it("no_signal uses below-borderline movement path", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.02],
      previousPrice: 100,
      currentPrice: 100.02,
      spikeThreshold: 0.001,
      borderlineMinRatio: 0.85,
      spikeMinRangeMultiple: 1.5,
    });
    expect(r.movementClassification).toBe("no_signal");
    expect(r.spikeDetected).toBe(false);
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

  it("rejects strong spike up when opposite side is too expensive", () => {
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
    expect(r.reasons).toEqual([ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH]);
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

  it("rejects strong spike down when opposite side is too expensive", () => {
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
    expect(r.reasons).toEqual([ENTRY_REASON_CODES.OPPOSITE_SIDE_PRICE_TOO_HIGH]);
  });

  it("rejects when both market prices are neutral", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.1, 100.05, 100.08, 105],
      previousPrice: 100.08,
      currentPrice: 105,
      upSidePrice: 0.49,
      downSidePrice: 0.51,
      entryPrice: 0.6,
      maxOppositeSideEntryPrice: 0.6,
      neutralQuoteBandMin: 0.45,
      neutralQuoteBandMax: 0.55,
    });
    expect(r.shouldEnter).toBe(false);
    expect(r.reasons).toEqual([ENTRY_REASON_CODES.MARKET_QUOTES_TOO_NEUTRAL]);
  });

  it("strong path can still fire when threshold is zero (edge case)", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 100.1, 100.05, 100, 100],
      previousPrice: 100,
      currentPrice: 100,
      spikeThreshold: 0,
    });
    expect(r.direction).toBe("UP");
    expect(r.shouldEnter).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("strong spike is not killed by contextual multiple filter", () => {
    const r = evaluateEntryConditions({
      ...base,
      prices: [100, 101, 99.5, 100.2, 100.45],
      previousPrice: 100.2,
      currentPrice: 100.45,
      rangeThreshold: 0.02,
      spikeThreshold: 0.002,
      spikeMinRangeMultiple: 5,
    });
    expect(r.shouldEnter).toBe(true);
    expect(r.movementClassification).toBe("strong_spike");
    expect(r.spikeDetected).toBe(true);
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
