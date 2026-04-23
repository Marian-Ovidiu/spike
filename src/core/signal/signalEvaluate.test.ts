import { describe, expect, it } from "vitest";
import { evaluateSignalConditions } from "./signalEvaluate.js";

const baseInput = () => ({
  rangeThreshold: 0.02,
  stableRangeSoftToleranceRatio: 1.5,
  strongSpikeHardRejectPoorRange: false,
  spikeThreshold: 0.01,
  spikeMinRangeMultiple: 2.2,
  borderlineMinRatio: 0.85,
  tradableSpikeMinPercent: 0.0015,
});

describe("evaluateSignalConditions", () => {
  it("actionable on strong spike without any book/spread inputs", () => {
    const r = evaluateSignalConditions({
      ...baseInput(),
      prices: [100, 125, 130],
      rangeThreshold: 0.001,
    });
    expect(r.actionable).toBe(true);
    expect(r.impulseDirection).toBe("up");
    expect(r.contrarianDirection).toBe("down");
    expect(r.rejections).toEqual([]);
  });

  it("not actionable when movement is noise", () => {
    const r = evaluateSignalConditions({
      ...baseInput(),
      prices: [100, 100.1, 100.05, 100.08, 100.09],
      spikeThreshold: 0.01,
    });
    expect(r.actionable).toBe(false);
    expect(r.rejections.length).toBeGreaterThan(0);
  });
});
