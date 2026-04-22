import { describe, expect, it } from "vitest";

import { buildSpikeDecisionTracePayload } from "./monitorConsole.js";
import type { NormalizedRejectionReason } from "./rejectionReasons.js";

describe("buildSpikeDecisionTracePayload", () => {
  const baseEntry = {
    shouldEnter: false,
    direction: "UP" as const,
    reasons: ["opposite_side_price_too_high"] as string[],
    stableRangeDetected: true,
    priorRangeFraction: 0.0008,
    stableRangeQuality: "good" as const,
    rangeDecisionNote: "",
    movementClassification: "strong_spike" as const,
    spikeDetected: true,
    movement: {
      strongestMovePercent: 0.0042,
      strongestMoveAbsolute: 1,
      strongestMoveDirection: "UP" as const,
      thresholdPercent: 0.005,
      thresholdRatio: 2,
      classification: "strong_spike" as const,
      sourceWindowLabel: "tick-1",
    },
    windowSpike: undefined,
  };

  const baseDecision = {
    action: "none" as const,
    direction: null,
    stableRangeQuality: "good" as const,
    movementClassification: "strong_spike" as const,
    spikeDetected: true,
    fastPathUsed: false,
    reason: "blocked by test",
    reasons: ["opposite_side_price_too_high"] as NormalizedRejectionReason[],
  };

  it("maps fields and lists normalized rejection reasons when not entering", () => {
    const p = buildSpikeDecisionTracePayload({
      entry: baseEntry,
      decision: baseDecision,
    });
    expect(p.spikePercent).toBeCloseTo(0.42, 6);
    expect(p.priorRange).toBe(0.08);
    expect(p.stableRange).toBe(true);
    expect(p.classification).toBe("strong_spike");
    expect(p.entryAllowed).toBe(false);
    expect(p.rejectionReasons).toContain("opposite_side_price_too_high");
  });

  it("clears rejection reasons when entry is allowed", () => {
    const p = buildSpikeDecisionTracePayload({
      entry: { ...baseEntry, shouldEnter: true, reasons: [] },
      decision: {
        ...baseDecision,
        action: "enter_immediate",
        direction: "UP",
        reasons: undefined,
      },
    });
    expect(p.entryAllowed).toBe(true);
    expect(p.rejectionReasons).toEqual([]);
  });

  it("strong_spike_waiting_confirmation_tick is not entryAllowed; notes deferral", () => {
    const p = buildSpikeDecisionTracePayload({
      entry: { ...baseEntry, shouldEnter: true, reasons: [] },
      decision: {
        ...baseDecision,
        action: "none",
        reason: "strong_spike_waiting_confirmation_tick",
        reasons: undefined,
      },
    });
    expect(p.entryAllowed).toBe(false);
    expect(p.rejectionReasons.length).toBeGreaterThan(0);
    expect(p.pipelineWatchPathDeferredNote).toContain(
      "strong_spike_waiting_confirmation_tick"
    );
  });
});
