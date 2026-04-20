import { describe, expect, it } from "vitest";

import { SignalMidRingBuffer } from "./signalMidRingBuffer.js";
import {
  resolveOpportunityCalibration,
  resolveTradeCalibration,
} from "./probabilityCalibrationResolve.js";
import type { SimulatedTrade } from "../../simulationEngine.js";

describe("probabilityCalibrationResolve", () => {
  it("defers trade calibration until horizon elapsed", () => {
    const ring = new SignalMidRingBuffer(120_000);
    ring.record(5_000, 100);
    ring.record(40_000, 110);
    const trade = {
      id: 1,
      executionModel: "binary" as const,
      openedAt: 10_000,
      underlyingSignalPriceAtEntry: 100,
      estimatedProbabilityUpAtEntry: 0.62,
    } as SimulatedTrade;
    expect(resolveTradeCalibration(trade, 30_000, ring, 25_000).kind).toBe(
      "deferred"
    );
    const r = resolveTradeCalibration(trade, 30_000, ring, 45_000);
    expect(r.kind).toBe("event");
    if (r.kind !== "event") return;
    expect(r.event.realizedUp).toBe(1);
    expect(r.event.horizonEndSignalMid).toBe(110);
  });

  it("resolves opportunity row when session end past horizon", () => {
    const ring = new SignalMidRingBuffer(120_000);
    ring.record(0, 50);
    ring.record(50_000, 55);
    const ev = resolveOpportunityCalibration({
      opportunityTimestampMs: 10_000,
      predictedProbabilityUp: 0.52,
      probabilityTimeHorizonMs: 30_000,
      referenceSignalMid: 50,
      ring,
      sessionEndMs: 100_000,
    });
    expect(ev).not.toBeNull();
    expect(ev!.realizedUp).toBe(1);
    expect(ev!.source).toBe("opportunity");
  });
});
