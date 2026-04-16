import { describe, expect, it } from "vitest";
import type { EntryEvaluation } from "./entryConditions.js";
import { evaluatePreEntryQualityGate } from "./preEntryQualityGate.js";

function makeEntry(overrides: Partial<EntryEvaluation>): EntryEvaluation {
  return {
    shouldEnter: false,
    direction: null,
    reasons: [],
    stableRangeDetected: true,
    priorRangePercent: 0.0004,
    stableRangeQuality: "good",
    rangeDecisionNote: "test",
    movementClassification: "no_signal",
    spikeDetected: false,
    movement: {
      strongestMovePercent: 0,
      strongestMoveAbsolute: 0,
      strongestMoveDirection: null,
      thresholdPercent: 0.001,
      thresholdRatio: 0,
      classification: "no_signal",
      sourceWindowLabel: null,
    },
    windowSpike: undefined,
    ...overrides,
  };
}

describe("evaluatePreEntryQualityGate", () => {
  it("returns weak below 0.15% even when movement class is strong_spike", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        movement: {
          strongestMovePercent: 0.0014,
          strongestMoveAbsolute: 140,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 1.4,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      })
    );
    expect(out.qualityGatePassed).toBe(false);
    expect(out.qualityProfile).toBe("weak");
    expect(out.qualityGateReasons).toContain("spike_below_tradable_min_percent");
  });

  it("returns strong profile at or above 0.15% and below 0.25%", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        movement: {
          strongestMovePercent: 0.0015,
          strongestMoveAbsolute: 150,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 1.5,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      })
    );
    expect(out.qualityGatePassed).toBe(true);
    expect(out.qualityProfile).toBe("strong");
  });

  it("downgrades acceptable movement to weak when range is poor", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        stableRangeQuality: "poor",
        movement: {
          strongestMovePercent: 0.00105,
          strongestMoveAbsolute: 105,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 1.05,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      })
    );
    expect(out.qualityGatePassed).toBe(false);
    expect(out.qualityProfile).toBe("weak");
    expect(out.qualityGateReasons).toContain("pre_spike_range_poor_quality");
    expect(out.diagnostics.profileAfterSpikeSizeTier).toBe("weak");
  });

  it("diagnostics show downgrade chain when strong tier hits poor pre-spike range", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        stableRangeQuality: "poor",
        movement: {
          strongestMovePercent: 0.002,
          strongestMoveAbsolute: 200,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 2.0,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      })
    );
    expect(out.diagnostics.profileAfterSpikeSizeTier).toBe("strong");
    expect(out.qualityProfile).toBe("weak");
    expect(
      out.diagnostics.downgradeChain.some(
        (s) => s.reasonCode === "pre_spike_range_poor_quality"
      )
    ).toBe(true);
  });

  it("keeps exceptional profile when poor range is overridden", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        stableRangeQuality: "poor",
        reasons: [],
        movement: {
          strongestMovePercent: 0.0025,
          strongestMoveAbsolute: 250,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 2.5,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      })
    );
    expect(out.qualityGatePassed).toBe(true);
    expect(out.qualityProfile).toBe("exceptional");
    expect(out.qualityGateReasons).toContain(
      "poor_range_overridden_by_exceptional_spike"
    );
  });

  it("returns exceptional at or above 0.25%", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        movement: {
          strongestMovePercent: 0.0025,
          strongestMoveAbsolute: 250,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 2.5,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      })
    );
    expect(out.qualityGatePassed).toBe(true);
    expect(out.qualityProfile).toBe("exceptional");
  });

  it("with default options adds disabled reason for weak profile (same as env OFF)", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        stableRangeQuality: "good",
        movement: {
          strongestMovePercent: 0.0014,
          strongestMoveAbsolute: 140,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 1.4,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      })
    );
    expect(out.qualityProfile).toBe("weak");
    expect(out.qualityGatePassed).toBe(false);
    expect(out.qualityGateReasons).toContain("weak_quality_entries_disabled_by_config");
  });

  it("allows weak strong_spike through gate when ALLOW_WEAK flags on (testing)", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        stableRangeQuality: "poor",
        priorRangePercent: 0.0004,
        movement: {
          strongestMovePercent: 0.002,
          strongestMoveAbsolute: 200,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 2,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      }),
      {
        allowWeakQualityEntries: true,
        allowWeakQualityOnlyForStrongSpikes: true,
      }
    );
    expect(out.qualityProfile).toBe("weak");
    expect(out.qualityGatePassed).toBe(true);
    expect(out.qualityGateReasons).toContain("weak_quality_entry_allowed_by_config");
  });

  it("does not allow weak bypass when prior range too wide even if ALLOW_WEAK on", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        stableRangeQuality: "good",
        priorRangePercent: 0.002,
        movement: {
          strongestMovePercent: 0.002,
          strongestMoveAbsolute: 200,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 2,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      }),
      {
        allowWeakQualityEntries: true,
        maxPriorRangeForNormalEntry: 0.0015,
      }
    );
    expect(out.qualityProfile).toBe("weak");
    expect(out.qualityGatePassed).toBe(false);
    expect(out.qualityGateReasons).toContain("weak_quality_blocked_prior_or_unstable_context");
  });

  it("blocks weak borderline when only strong spikes may use weak bypass", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "borderline",
        spikeDetected: false,
        stableRangeQuality: "good",
        movement: {
          strongestMovePercent: 0.0014,
          strongestMoveAbsolute: 140,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 1.4,
          classification: "borderline",
          sourceWindowLabel: "tick-1",
        },
      }),
      {
        allowWeakQualityEntries: true,
        allowWeakQualityOnlyForStrongSpikes: true,
      }
    );
    expect(out.qualityProfile).toBe("weak");
    expect(out.qualityGatePassed).toBe(false);
    expect(out.qualityGateReasons).toContain("weak_quality_borderline_blocked_by_config");
  });

  it("fails strict gate when priorRangePercent exceeds maxPriorRangeForNormalEntry", () => {
    const out = evaluatePreEntryQualityGate(
      makeEntry({
        movementClassification: "strong_spike",
        spikeDetected: true,
        priorRangePercent: 0.0016,
        movement: {
          strongestMovePercent: 0.0020,
          strongestMoveAbsolute: 200,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 2.0,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
      }),
      { maxPriorRangeForNormalEntry: 0.0015 }
    );
    expect(out.qualityGatePassed).toBe(false);
    expect(out.qualityProfile).toBe("weak");
    expect(out.qualityGateReasons).toContain(
      "prior_range_too_wide_for_mean_reversion"
    );
  });
});

