import { describe, expect, it } from "vitest";
import type { EntryEvaluation } from "./entryConditions.js";
import {
  applyUnstableSoftOverlayOnQualityGate,
  evaluateHardRejectContext,
} from "./hardRejectEngine.js";
import type { PreEntryQualityGateResult } from "./preEntryQualityGate.js";

function baseEntry(over: Partial<EntryEvaluation>): EntryEvaluation {
  return {
    shouldEnter: false,
    direction: null,
    reasons: [],
    movementClassification: "strong_spike",
    spikeDetected: true,
    stableRangeDetected: false,
    priorRangeFraction: 0.01,
    stableRangeQuality: "acceptable",
    rangeDecisionNote: "t",
    windowSpike: undefined,
    movement: {
      strongestMovePercent: 0.002,
      strongestMoveAbsolute: 200,
      strongestMoveDirection: "UP",
      thresholdPercent: 0.001,
      thresholdRatio: 2,
      classification: "strong_spike",
      sourceWindowLabel: null,
    },
    ...over,
  };
}

const stubGate: PreEntryQualityGateResult = {
  qualityGatePassed: true,
  qualityGateReasons: ["ok"],
  qualityProfile: "strong",
  diagnostics: {
    classification: "rule_based",
    effectiveThresholds: {
      tradableSpikeMinPercent: 0.001,
      exceptionalSpikeMinPercent: 0.01,
      maxPriorRangeForNormalEntry: 0.002,
    },
    inputs: {
      movementClassification: "strong_spike",
      strongestMovePercent: 0.002,
      spikePercent: 0.2,
      thresholdRatio: 2,
      priorRangeFraction: 0.01,
      stableRangeDetected: false,
      stableRangeQuality: "acceptable",
      entryReasonCodes: [],
    },
    profileAfterSpikeSizeTier: "strong",
    ruleChecks: [],
    downgradeChain: [],
    finalProfile: "strong",
    qualityGatePassed: true,
    weakPrimaryReasons: [],
  },
};

describe("evaluateHardRejectContext", () => {
  it("hard mode: applies hard reject when prior range wide and no stable range", () => {
    const r = evaluateHardRejectContext({
      entry: baseEntry({}),
      hardRejectPriorRangePercent: 0.002,
      unstableContextMode: "hard",
    });
    expect(r.hardRejectApplied).toBe(true);
    expect(r.hardRejectReason).toBe("hard_reject_unstable_pre_spike_context");
    expect(r.unstablePreSpikeContextDetected).toBe(true);
    expect(r.unstableContextHandling).toBe("hard_reject");
    expect(r.unstablePreSpikeContextMetrics?.priorRangeFraction).toBe(0.01);
  });

  it("soft mode: defers hard reject but records detection", () => {
    const r = evaluateHardRejectContext({
      entry: baseEntry({}),
      hardRejectPriorRangePercent: 0.002,
      unstableContextMode: "soft",
    });
    expect(r.hardRejectApplied).toBe(false);
    expect(r.hardRejectReason).toBeNull();
    expect(r.unstablePreSpikeContextDetected).toBe(true);
    expect(r.unstableContextHandling).toBe("soft_deferred");
  });

  it("no match when stable range detected", () => {
    const r = evaluateHardRejectContext({
      entry: baseEntry({ stableRangeDetected: true }),
      hardRejectPriorRangePercent: 0.002,
      unstableContextMode: "hard",
    });
    expect(r.hardRejectApplied).toBe(false);
    expect(r.unstableContextHandling).toBe("none");
  });
});

describe("applyUnstableSoftOverlayOnQualityGate", () => {
  it("merges reasons and diagnostics only for soft_deferred", () => {
    const hr = evaluateHardRejectContext({
      entry: baseEntry({}),
      hardRejectPriorRangePercent: 0.002,
      unstableContextMode: "soft",
    });
    const merged = applyUnstableSoftOverlayOnQualityGate(stubGate, hr);
    expect(merged.qualityGateReasons).toContain(
      "unstable_pre_spike_context_soft_handling"
    );
    expect(merged.diagnostics.unstableContextHandling).toBe("soft_deferred");
    expect(merged.diagnostics.unstablePreSpikeContextMetrics?.threshold).toBe(
      0.002
    );
  });

  it("leaves gate unchanged when handling is none", () => {
    const hr = evaluateHardRejectContext({
      entry: baseEntry({ stableRangeDetected: true }),
      hardRejectPriorRangePercent: 0.002,
      unstableContextMode: "soft",
    });
    const merged = applyUnstableSoftOverlayOnQualityGate(stubGate, hr);
    expect(merged.qualityGateReasons).toEqual(stubGate.qualityGateReasons);
  });
});
