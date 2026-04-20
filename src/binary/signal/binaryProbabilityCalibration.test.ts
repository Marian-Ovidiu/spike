import { describe, expect, it } from "vitest";

import {
  buildCalibrationReliabilityReport,
  calibrationBucketForProbability,
} from "./binaryProbabilityCalibration.js";
import type { ProbabilityCalibrationEvent } from "./binaryProbabilityCalibration.js";
import { PROBABILITY_CALIBRATION_SCHEMA } from "./binaryProbabilityCalibration.js";

function ev(
  p: number,
  y: 0 | 1,
  edge?: number
): ProbabilityCalibrationEvent {
  return {
    schema: PROBABILITY_CALIBRATION_SCHEMA,
    source: "trade",
    referenceTimeMs: 0,
    probabilityTimeHorizonMs: 30_000,
    resolvedAtMs: 1,
    predictedProbabilityUp: p,
    referenceSignalMid: 1,
    horizonEndSignalMid: 1 + y * 0.001,
    realizedUp: y,
    ...(edge !== undefined ? { entryModelEdge: edge } : {}),
    tradeId: 1,
  };
}

describe("binaryProbabilityCalibration", () => {
  it("places probabilities into half-decade buckets", () => {
    expect(calibrationBucketForProbability(0.52)).toBe("0.50–0.55");
    expect(calibrationBucketForProbability(0.59)).toBe("0.55–0.60");
    expect(calibrationBucketForProbability(0.6)).toBe("0.60–0.65");
    expect(calibrationBucketForProbability(0.499)).toBe("<0.50");
  });

  it("builds report with bucket frequencies", () => {
    const events: ProbabilityCalibrationEvent[] = [
      ...Array.from({ length: 10 }, () => ev(0.52, 1)),
      ...Array.from({ length: 10 }, () => ev(0.52, 0)),
    ];
    const r = buildCalibrationReliabilityReport(events);
    expect(r.totalSamples).toBe(20);
    const b = r.buckets.find((x) => x.label === "0.50–0.55");
    expect(b?.sampleCount).toBe(20);
    expect(b?.realizedUpFrequency).toBeCloseTo(0.5, 5);
    expect(r.meanPredictedMinusRealized).toBeCloseTo(0.02, 5);
  });
});
